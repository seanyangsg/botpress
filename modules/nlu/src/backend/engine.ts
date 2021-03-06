import retry from 'bluebird-retry'
import * as sdk from 'botpress/sdk'
import crypto from 'crypto'
import fs from 'fs'
import { flatMap } from 'lodash'
import _ from 'lodash'

import { Config } from '../config'

import { DucklingEntityExtractor } from './pipelines/entities/duckling_extractor'
import { extractListEntities, extractPatternEntities } from './pipelines/entities/pattern_extractor'
import FastTextClassifier from './pipelines/intents/ft_classifier'
import { createIntentMatcher } from './pipelines/intents/matcher'
import { FastTextLanguageId } from './pipelines/language/ft_lid'
import CRFExtractor from './pipelines/slots/crf_extractor'
import { generateTrainingSequence } from './pipelines/slots/pre-processor'
import Storage from './storage'
import { EntityExtractor, LanguageIdentifier, Prediction, SlotExtractor } from './typings'

export default class ScopedEngine {
  public readonly storage: Storage
  public confidenceTreshold: number = 0.7

  private readonly intentClassifier: FastTextClassifier
  private readonly langDetector: LanguageIdentifier
  private readonly systemEntityExtractor: EntityExtractor
  private readonly slotExtractor: SlotExtractor

  private retryPolicy = {
    interval: 100,
    max_interval: 500,
    timeout: 5000,
    max_tries: 3
  }

  constructor(
    private logger: sdk.Logger,
    private botId: string,
    private readonly config: Config,
    private readonly toolkit: typeof sdk.MLToolkit
  ) {
    this.storage = new Storage(config, this.botId)
    this.intentClassifier = new FastTextClassifier(this.logger)
    this.langDetector = new FastTextLanguageId(this.logger)
    this.systemEntityExtractor = new DucklingEntityExtractor(this.logger)
    this.slotExtractor = new CRFExtractor(toolkit)
  }

  async init(): Promise<void> {
    this.confidenceTreshold = this.config.confidenceTreshold

    if (isNaN(this.confidenceTreshold) || this.confidenceTreshold < 0 || this.confidenceTreshold > 1) {
      this.confidenceTreshold = 0.7
    }

    if (await this.checkSyncNeeded()) {
      await this.sync()
    }
  }

  async sync(): Promise<void> {
    const intents = await this.storage.getIntents()
    const modelHash = this._getIntentsHash(intents)

    // this is only good for intents model at the moment. soon we'll store crf, skipgram an kmeans model necessary for crf extractor
    if (await this.storage.modelExists(modelHash)) {
      await this._loadModel(modelHash)
    } else {
      await this._trainModel(intents, modelHash)
    }

    // TODO try to load model if saved(we don't save at the moment)
    try {
      const trainingSet = flatMap(intents, intent => {
        return intent.utterances.map(utterance => generateTrainingSequence(utterance, intent.slots, intent.name))
      })
      await this.slotExtractor.train(trainingSet)
    } catch (err) {
      this.logger.error('Error training slot tagger', err)
    }
  }

  async extract(incomingEvent: sdk.IO.Event): Promise<sdk.IO.EventUnderstanding> {
    return retry(() => this._extract(incomingEvent), this.retryPolicy)
  }

  async checkSyncNeeded(): Promise<boolean> {
    const intents = await this.storage.getIntents()

    if (intents.length) {
      const intentsHash = this._getIntentsHash(intents)
      return this.intentClassifier.currentModelId !== intentsHash
    }

    return false
  }

  private async _loadModel(modelHash: string) {
    this.logger.debug(`Restoring intents model '${modelHash}' from storage`)
    const modelBuffer = await this.storage.getModelAsBuffer(modelHash)
    this.intentClassifier.loadModel(modelBuffer, modelHash)
  }

  private async _trainModel(intents: any[], modelHash: string) {
    try {
      this.logger.debug('The intents model needs to be updated, training model ...')
      const intentModelPath = await this.intentClassifier.train(intents, modelHash)
      const intentModelBuffer = fs.readFileSync(intentModelPath)
      const intentModelName = `${Date.now()}__${modelHash}.bin`
      await this.storage.persistModel(intentModelBuffer, intentModelName)
      this.logger.debug('Intents done training')
    } catch (err) {
      return this.logger.attachError(err).error('Error training intents')
    }
  }

  private _getIntentsHash(intents) {
    return crypto
      .createHash('md5')
      .update(JSON.stringify(intents))
      .digest('hex')
  }

  private async _extractEntities(text, lang): Promise<sdk.NLU.Entity[]> {
    const customEntityDefs = await this.storage.getCustomEntities()
    const patternEntities = extractPatternEntities(text, customEntityDefs.filter(ent => ent.type === 'pattern'))
    const listEntities = extractListEntities(text, customEntityDefs.filter(ent => ent.type === 'list'))
    const systemEntities = await this.systemEntityExtractor.extract(text, lang)

    return [...systemEntities, ...patternEntities, ...listEntities]
  }

  private async _extract(incomingEvent: sdk.IO.Event): Promise<sdk.IO.EventUnderstanding> {
    const ret: any = { errored: true }
    try {
      const text = incomingEvent.preview
      ret.language = await this.langDetector.identify(text)
      ret.intents = await this.intentClassifier.predict(text)
      const intent = findMostConfidentPredictionMeanStd(ret.intents, this.confidenceTreshold)
      ret.intent = { ...intent, matches: createIntentMatcher(intent.name) }
      ret.entities = await this._extractEntities(text, ret.language)

      const intentDef = await this.storage.getIntent(intent.name)
      ret.slots = await this.slotExtractor.extract(text, intentDef, ret.entities)
      ret.errored = false

    } catch (error) {
      this.logger.warn(`Could not extract whole NLU data, ${error}`)
    } finally {
      return ret as sdk.IO.EventUnderstanding
    }
  }
}

export const NonePrediction: Prediction = {
  confidence: 1.0,
  name: 'none'
}

/**
 * Finds the most confident intent, either by the intent being above a fixed threshold, or else if an intent is more than {@param std} standard deviation (outlier method).
 * @param intents
 * @param fixedThreshold
 * @param std number of standard deviation away. normally between 2 and 5
 */
export function findMostConfidentPredictionMeanStd(
  intents: Prediction[],
  fixedThreshold: number,
  std: number = 3
): Prediction {
  if (!intents.length) {
    return NonePrediction
  }

  const best = intents.find(x => x.confidence >= fixedThreshold)

  if (best) {
    return best
  }

  const mean = _.meanBy<Prediction>(intents, 'confidence')
  const stdErr =
    Math.sqrt(intents.reduce((a, c) => a + Math.pow(c.confidence - mean, 2), 0) / intents.length) /
    Math.sqrt(intents.length)

  const dominant = intents.find(x => x.confidence >= stdErr * std + mean)

  return dominant || NonePrediction
}
