import 'bluebird-global'
import * as sdk from 'botpress/sdk'

import { Config } from '../config'

import api from './api'
import { registerMiddleware } from './middleware'
import fastText from './tools/fastText'

import ScopedEngine from './engine'
import { DucklingEntityExtractor } from './pipelines/entities/duckling_extractor'
import Storage from './storage'
import { EngineByBot } from './typings'

const nluByBot: EngineByBot = {}

const onServerStarted = async (bp: typeof sdk) => {
  Storage.ghostProvider = botId => bp.ghost.forBot(botId)

  const globalConfig = (await bp.config.getModuleConfig('nlu')) as Config
  globalConfig.fastTextPath && fastText.configure(globalConfig.fastTextPath)
  DucklingEntityExtractor.configure(globalConfig.ducklingEnabled, globalConfig.ducklingURL)

  await registerMiddleware(bp, nluByBot)
}

const onServerReady = async (bp: typeof sdk) => {
  await api(bp, nluByBot)
}

const onBotMount = async (bp: typeof sdk, botId: string) => {
  const moduleBotConfig = (await bp.config.getModuleConfigForBot('nlu', botId)) as Config
  const scoped = new ScopedEngine(bp.logger, botId, moduleBotConfig, bp.MLToolkit)
  await scoped.init()
  nluByBot[botId] = scoped
}

const onBotUnmount = async (bp: typeof sdk, botId: string) => {
  delete nluByBot[botId]
}

const entryPoint: sdk.ModuleEntryPoint = {
  onServerStarted,
  onServerReady,
  onBotMount,
  onBotUnmount,
  definition: {
    name: 'nlu',
    moduleView: {
      stretched: true
    },
    menuIcon: 'fiber_smart_record',
    menuText: 'NLU',
    fullName: 'NLU',
    homepage: 'https://botpress.io'
  }
}

export default entryPoint
