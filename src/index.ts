// core
import { EventEmitter } from 'events'

// public
import { RedisClient } from 'redis'
import { ulid } from 'ulid'

// local
import { generateObjectSignature } from './utils/generateObjectSignature'
import { debug } from './utils/debug'

interface InternalDistributedPromiseConfig {
	redis: RedisClient;
	lockTimeout: number;
	lockPrefix: string;
	notifPrefix: string;
	keyPrefix: string;
	keySeperator: string;
	ttl: number;
}

export interface DistributedPromiseConfig extends Partial<InternalDistributedPromiseConfig> {
	redis: RedisClient;
}

interface InternalWrapConfig {
	key: string;
	timeout: number;
}

export interface WrapConfig extends Partial<InternalWrapConfig> {
	key: string;
}

interface TimersMap {
	[key: string]: NodeJS.Timeout;
}

export class DistributedPromiseWrapper {
	private _config: InternalDistributedPromiseConfig
	private _subscriber: RedisClient
	private _emitter: EventEmitter = new EventEmitter()
	private _timers: TimersMap = {}

	constructor (config: DistributedPromiseConfig) {
		this._config = {
			...config,
			lockTimeout: config.lockTimeout ?? 30000,
			keyPrefix: config.keyPrefix ?? 'distributed-promise',
			lockPrefix: config.lockPrefix ?? 'lock',
			notifPrefix: config.notifPrefix ?? 'notif',
			keySeperator: config.keySeperator ?? ':',
			ttl: config.ttl ?? (1000 * 60 * 30)
		}

		this._subscriber = this._config.redis.duplicate()
		this._subscriber.on('message', this._messageReceived.bind(this))
		debug('created new DistributedPromiseWrapper')
	}

	public wrap<T extends (...args: any[]) => Promise<any>> (
		work: T,
		config: WrapConfig
	): (...args: Parameters<T>) => ReturnType<T>;

	public wrap<T extends (...args: any[]) => Promise<any>> (
		work: T,
		rawKey?: string
	): (...args: Parameters<T>) => ReturnType<T>;

	public wrap<T extends (...args: any[]) => Promise<any>> (
		work: T,
		extra?: WrapConfig | string
	): (...args: Parameters<T>) => ReturnType<T> {
		const inputConfig: WrapConfig = extra
			? typeof extra === 'string'
				? { key: extra }
				: { ...extra }
			: { key: work.name }

		if (!inputConfig.key) {
			throw new Error('Invalid config provided; no key')
		}

		const config: InternalWrapConfig = {
			...inputConfig,
			timeout: inputConfig.timeout ?? this._config.lockTimeout
		}

		// fix typescript issue when type aliasing promise return types
		// const U = Promise
		debug('wrapping', work)

		return (...args: Parameters<T>): ReturnType<T> => new Promise(async (resolve, reject) => {
			const key = [config.key, generateObjectSignature(args)].join(this._config.keySeperator)

			debug('running', work, `; internal key is "${key}"`)
			debug('fetching cached data')

			// see if we can get from cache straight away
			let cachedData = await this._get(key)

			if (cachedData) {
				debug('cache hit; returning data')

				return resolve(cachedData)
			}

			// cache miss
			debug('cache miss')

			// try getting lock to see if we perform work
			debug('attempting to get lock')
			const haveLock = await this._getLock(key)

			if (haveLock) {
				debug('got lock, so performing work via', work)
				const freshData = await work(...args)
				debug('work complete; pushing data')
				await this._pushData(key, freshData)
				debug('data pushed; returning data')

				return resolve(freshData)
			}

			// no lock
			debug('could not get lock; another process must be performing work, so setting up subscriber')

			const timerId = ulid()

			const cleanUp = async (data?: any): Promise<void> => {
				debug('cleaning up after cache attempts')
				clearTimeout(this._timers[timerId])
				debug('cleared timeout')
				await this._unsubscribe(key, cleanUp)
				debug('unsubscribed')

				if (data instanceof Error) {
					console.error(data)

					return reject(data)
				}

				return resolve(data)
			}

			this._timers[timerId] = setTimeout(
				cleanUp,
				config.timeout,
				new Error('Failed to perform work waiting for another process.')
			)

			debug('timeout set; subscribing...')

			await this._subscribe(key, cleanUp)

			// refetch in case we missed from cache
			debug('attempt refetch in case we missed from cache')
			cachedData = await this._get(key)

			if (cachedData) {
				debug('refetch worked; cleaning up and returning data')
				return cleanUp(cachedData)
			}

			debug('refetch cold; waiting for data from redis')
		}) as ReturnType<T>
	}

	private _parseData (input: string): any {
		return JSON.parse(input)
	}

	private _serialiseData (input: any): string {
		return JSON.stringify(input)
	}

	private _get (key: string): Promise<any> {
		const dataKey = this._getDataKey(key)

		return new Promise((resolve, reject) => {
			debug(`getting data from "${dataKey}"`)

			this._config.redis.get(dataKey, (err, serialisedData) => {
				if (err) return reject(err)

				const data = this._parseData(serialisedData)

				return resolve(data)
			})
		})
	}

	private async _pushData (key: string, data: any): Promise<boolean> {
		const dataKey = this._getDataKey(key)
		const notifKey = this._getNotifKey(key)

		return new Promise((resolve, reject) => {
			debug(`pushing data to "${dataKey}"`)
			debug(`notifying listeners of data at "${notifKey}"`)

			const serialisedData = this._serialiseData(data)

			this._config.redis.multi()
				.psetex(dataKey, this._config.ttl, serialisedData)
				.publish(notifKey, serialisedData)
				.exec((err) => {
					if (err) return reject(err)

					return resolve(true)
				})
		})
	}

	private async _subscribe (key: string, callback: (...args: any[]) => void): Promise<boolean> {
		const notifKey = this._getNotifKey(key)

		debug(`listening to messages from "${notifKey}"`)
		this._emitter.once(notifKey, callback)

		return this._subscriber.subscribe(notifKey)
	}

	private async _unsubscribe (key: string, callback: (...args: any[]) => void): Promise<boolean> {
		const notifKey = this._getNotifKey(key)

		debug(`removing listener from "${notifKey}"`)
		this._emitter.removeListener(notifKey, callback)

		return this._subscriber.unsubscribe(notifKey)
	}

	private _messageReceived (channel: string, serialisedData: string): void {
		debug(`received "${channel}" message from redis`)

		const data = this._parseData(serialisedData)

		this._emitter.emit(channel, data)
	}

	private async _getLock (key: string): Promise<boolean> {
		const lockKey = this._getLockKey(key)

		return new Promise((resolve, reject) => {
			debug(`attempting to get lock at "${lockKey}"`)

			this._config.redis.set(
				lockKey, // key
				'1', // value
				'PX', this._config.lockTimeout, // ttl
				'NX', // set if does Not eXist
				(err, set) => {
					if (err) return reject(err)

					return resolve(Boolean(set))
				}
			)
		})
	}

	private _getNotifKey (key: string): string {
		return [this._config.keyPrefix, this._config.notifPrefix, key].join(this._config.keySeperator)
	}

	private _getLockKey (key: string): string {
		return [this._config.keyPrefix, this._config.lockPrefix, key].join(this._config.keySeperator)
	}

	private _getDataKey (key: string): string {
		return [this._config.keyPrefix, key].join(this._config.keySeperator)
	}
}
