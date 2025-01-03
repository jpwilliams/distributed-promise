import { DistributedPromiseWrapper } from './index'
import { RedisClient } from 'redis'
import { EventEmitter } from 'events'

jest.mock('redis', () => ({
  createClient: jest.fn().mockReturnValue({
    get: jest.fn(),
    set: jest.fn(),
    psetex: jest.fn(),
    publish: jest.fn(),
    subscribe: jest.fn(),
    unsubscribe: jest.fn(),
    duplicate: jest.fn().mockReturnThis(),
    on: jest.fn()
  })
}))

describe('DistributedPromiseWrapper', () => {
  let redisClient: RedisClient
  let wrapper: DistributedPromiseWrapper

  beforeEach(() => {
    redisClient = new RedisClient({})
    wrapper = new DistributedPromiseWrapper({ redis: redisClient })
  })

  describe('wrap', () => {
    it('should handle cache hits', async () => {
      const work = jest.fn().mockResolvedValue('result')
      const key = 'testKey'
      const args = ['arg1', 'arg2']

      redisClient.get = jest.fn((_, cb) => cb(null, JSON.stringify('cachedResult')))

      const wrappedWork = wrapper.wrap(work, key)
      const result = await wrappedWork(...args)

      expect(result).toBe('cachedResult')
      expect(work).not.toHaveBeenCalled()
    })

    it('should handle cache misses and acquire lock', async () => {
      const work = jest.fn().mockResolvedValue('result')
      const key = 'testKey'
      const args = ['arg1', 'arg2']

      redisClient.get = jest.fn((_, cb) => cb(null, null))
      redisClient.set = jest.fn((_, __, ___, ____, cb) => cb(null, 'OK'))
      redisClient.psetex = jest.fn((_, __, ___, cb) => cb(null))
      redisClient.publish = jest.fn((_, __, cb) => cb(null))

      const wrappedWork = wrapper.wrap(work, key)
      const result = await wrappedWork(...args)

      expect(result).toBe('result')
      expect(work).toHaveBeenCalledWith(...args)
    })

    it('should handle cache misses and wait for another process', async () => {
      const work = jest.fn().mockResolvedValue('result')
      const key = 'testKey'
      const args = ['arg1', 'arg2']

      redisClient.get = jest.fn((_, cb) => cb(null, null))
      redisClient.set = jest.fn((_, __, ___, ____, cb) => cb(null, null))
      redisClient.subscribe = jest.fn((_, cb) => cb(null))
      redisClient.on = jest.fn((event, cb) => {
        if (event === 'message') {
          cb(wrapper['_getNotifKey'](key), JSON.stringify('result'))
        }
      })

      const wrappedWork = wrapper.wrap(work, key)
      const result = await wrappedWork(...args)

      expect(result).toBe('result')
      expect(work).not.toHaveBeenCalled()
    })
  })

  describe('_get', () => {
    it('should get data from Redis', async () => {
      const key = 'testKey'
      const data = 'testData'

      redisClient.get = jest.fn((_, cb) => cb(null, JSON.stringify(data)))

      const result = await wrapper['_get'](key)

      expect(result).toBe(data)
    })
  })

  describe('_pushData', () => {
    it('should push data to Redis and publish notification', async () => {
      const key = 'testKey'
      const data = 'testData'

      redisClient.psetex = jest.fn((_, __, ___, cb) => cb(null))
      redisClient.publish = jest.fn((_, __, cb) => cb(null))

      const result = await wrapper['_pushData'](key, data)

      expect(result).toBe(true)
    })
  })

  describe('_subscribe', () => {
    it('should subscribe to a Redis channel', async () => {
      const key = 'testKey'
      const callback = jest.fn()

      redisClient.subscribe = jest.fn((_, cb) => cb(null))

      const result = await wrapper['_subscribe'](key, callback)

      expect(result).toBe(true)
    })
  })

  describe('_unsubscribe', () => {
    it('should unsubscribe from a Redis channel', async () => {
      const key = 'testKey'
      const callback = jest.fn()

      redisClient.unsubscribe = jest.fn((_, cb) => cb(null))

      const result = await wrapper['_unsubscribe'](key, callback)

      expect(result).toBe(true)
    })
  })

  describe('_messageReceived', () => {
    it('should emit an event with parsed data', () => {
      const channel = 'testChannel'
      const data = 'testData'
      const parsedData = JSON.stringify(data)

      const emitter = new EventEmitter()
      wrapper['_emitter'] = emitter

      const emitSpy = jest.spyOn(emitter, 'emit')

      wrapper['_messageReceived'](channel, parsedData)

      expect(emitSpy).toHaveBeenCalledWith(channel, data)
    })
  })

  describe('_getLock', () => {
    it('should acquire a lock in Redis', async () => {
      const key = 'testKey'

      redisClient.set = jest.fn((_, __, ___, ____, cb) => cb(null, 'OK'))

      const result = await wrapper['_getLock'](key)

      expect(result).toBe(true)
    })
  })

  describe('_getNotifKey', () => {
    it('should return the notification key', () => {
      const key = 'testKey'
      const expectedNotifKey = `${wrapper['_config'].keyPrefix}${wrapper['_config'].keySeperator}${wrapper['_config'].notifPrefix}${wrapper['_config'].keySeperator}${key}`

      const result = wrapper['_getNotifKey'](key)

      expect(result).toBe(expectedNotifKey)
    })
  })

  describe('_getLockKey', () => {
    it('should return the lock key', () => {
      const key = 'testKey'
      const expectedLockKey = `${wrapper['_config'].keyPrefix}${wrapper['_config'].keySeperator}${wrapper['_config'].lockPrefix}${wrapper['_config'].keySeperator}${key}`

      const result = wrapper['_getLockKey'](key)

      expect(result).toBe(expectedLockKey)
    })
  })

  describe('_getDataKey', () => {
    it('should return the data key', () => {
      const key = 'testKey'
      const expectedDataKey = `${wrapper['_config'].keyPrefix}${wrapper['_config'].keySeperator}${key}`

      const result = wrapper['_getDataKey'](key)

      expect(result).toBe(expectedDataKey)
    })
  })
})
