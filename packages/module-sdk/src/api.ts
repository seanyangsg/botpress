import { BotpressEvent, MiddlewareDefinition } from '.'
import { ExtendedKnex, GetOrCreateResult } from './database'
import { HttpAPI } from './http'
import { RealTimeAPI } from './realtime'
import { ChannelUser, ChannelUserAttribute } from './user'

export interface EventAPI {
  registerMiddleware(middleware: MiddlewareDefinition): void
  sendEvent(event: BotpressEvent): void
}

export interface UserAPI {
  getOrCreateUser(channelName: string, userId: string): GetOrCreateResult<ChannelUser>
  updateAttributes(channel: string, id: string, attributes: ChannelUserAttribute[]): Promise<void>
}

export interface DialogAPI {
  processMessage(userId: string, event: BotpressEvent): Promise<void>
  deleteSession(userId: string): Promise<void>
  getState(userId: string): Promise<void>
  setState(userId: string, state: any): Promise<void>
}

export interface Logger {
  forBot(botId: string): this
  debug(message: string, metadata?: any): void
  info(message: string, metadata?: any): void
  warn(message: string, metadata?: any): void
  error(message: string, metadata?: any): void
  error(message: string, error: Error, metadata?: any): void
}

export interface ConfigAPI {
  getModuleConfig(moduleId: string): Promise<any>
  getModuleConfigForBot(moduleId: string, botId: string): Promise<any>
}

export type LoggerAPI = Logger

// users_channels
// users_profile
// users_bots
// users_channels_merges

export type BotpressAPI = {
  http: HttpAPI
  events: EventAPI
  logger: LoggerAPI
  dialog: DialogAPI
  config: ConfigAPI
  database: ExtendedKnex
  users: UserAPI
  realtime: RealTimeAPI
}
