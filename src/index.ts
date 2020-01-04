// core
import { EventEmitter } from 'events'

// public
import { RedisClient } from 'redis'
import { ulid } from 'ulid'

// local
import { generateObjectSignature } from './utils/generateObjectSignature'

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

		return (...args: Parameters<T>): ReturnType<T> => new Promise(async (resolve, reject) => {
			const key = [config.key, generateObjectSignature(args)].join(this._config.keySeperator)

			// see if we can get from cache straight away
			let cachedData = await this._get(key)
			if (cachedData) return resolve(cachedData)

			// cache miss
			// try getting lock to see if we perform work
			const haveLock = await this._getLock(key)

			if (haveLock) {
				const freshData = await work(...args)
				await this._pushData(key, freshData)

				return resolve(freshData)
			}

			// no lock
			const timerId = ulid()

			const cleanUp = async (data?: any): Promise<void> => {
				clearTimeout(this._timers[timerId])
				await this._unsubscribe(key, cleanUp)

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

			await this._subscribe(key, cleanUp)

			// refetch in case we missed from cache
			cachedData = await this._get(key)
			if (cachedData) return cleanUp(cachedData)
		})
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
		this._emitter.once(notifKey, callback)

		return this._subscriber.subscribe(notifKey)
	}

	private async _unsubscribe (key: string, callback: (...args: any[]) => void): Promise<boolean> {
		const notifKey = this._getNotifKey(key)
		this._emitter.removeListener(notifKey, callback)

		return this._subscriber.unsubscribe(notifKey)
	}

	private _messageReceived (channel: string, serialisedData: string): void {
		const data = this._parseData(serialisedData)

		this._emitter.emit(channel, data)
	}

	private async _getLock (key: string): Promise<boolean> {
		const lockKey = this._getLockKey(key)

		return new Promise((resolve, reject) => {
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
