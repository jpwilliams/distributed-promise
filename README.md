# @jpwilliams/distributed-promise

[![Greenkeeper badge](https://badges.greenkeeper.io/jpwilliams/distributed-promise.svg)](https://greenkeeper.io/)

Distribute a promise across multiple processes connected via Redis. If two seperate processes make the same call, only one will actually do the work, but both promises will return simultaneously with the same data.

Has pretty types and works with any data compatible with `JSON.stringify` and `JSON.parse`.

``` sh
npm install --save @jpwilliams/distributed-promise
```

``` js
import { DistributedPromiseWrapper } from '@jpwilliams/distributed-promise'

const wrapper = new DistributedPromiseWrapper({
	redis: myRedisClient
})

// any function
// can be synchronous or asynchronous
function joinStr (...strs) {
	return strs.join()
}

const sharedJoinStr = wrapper.wrap(joinStr)
const result = await sharedJoinStr('foo', 'bar')
// result = 'foobar'
```

## Why?

This facilitates the [memoisation](https://en.wikipedia.org/wiki/Memoization) of expensive function calls in a distributed system and helps combat the issue of a [cache stampede](https://en.wikipedia.org/wiki/Cache_stampede).

It does this by only allowing a single service per job to actually do the work and makes all other services wait for _that_ result and _not_ compute their own.

## How

First, after creating a wrapper via `new DistributedPromiseWrapper`, you can wrap any functions for use with the library, regardless of what they return. The wrapping process will _always_ return a function that returns a Promise, even if the original function did not.

``` js
// (...objs: object[]): object
const combine = (...objs: object[]): object => Object.assign(...objs)

// (...objs: object[]): Promise<object>
const sharedCombine = wrapper.wrap(combine)
```

Internally, when a wrapped function is called, a simple route is followed:

1. Get relevant data from cache based on input args. Found data? Return it.
2. Try to attain a lock to get permission to do the work locally.
3. If we get the lock, perform work locally, push the result to the cache, publish via Redis and return.
4. If we didn't get the lock, wait for the data to be published via Redis and return it when it arrives.

In basic terms, if

## API

### `new DistributedPromiseWrapper(config: DistributedPromiseConfig)`

Creates a new wrapper to use to wrap functions.

**config** `DistributedPromiseConfig`
- `redis: RedisClient` The `RedisClient` instance to use to connect.
- `lockTimeout?: number` The amount of time in milliseconds to hold the Redis lock for when doing work locally. Defaults to `30000` (30 seconds).
- `ttl?: number` The amount of time in milliseconds before items expire from the cache. Defaults to `1800000` (30 minutes).
- `keyPrefix?: string` The prefix to use for all keys the library uses in Redis. Defaults to `distributed-promise`.
- `lockPrefix?: string` The prefix to use for locks in Redis. Defaults to `lock`.
- `notifPrefix?: string` The prefix to use for notifications in Redis. Defaults to `notif`.
- `keySeperator?: string` The seperator to use between the segments of key data in Redis. Defaults to `:`.

**Returns** `DistributedPromiseWrapper`.

---

### `DistributedPromiseWrapper.wrap(work: InputFn, config?: WrapConfig | string)`

Wraps a function, ready to share. An internal key is needed for caching and data retrieval. If just `work` is passed, this key will be the `name` of the function. If it does not have one, the library will throw.

**work** `InputFn`

A function. `(...args: any) => any` - any arguments and any return.

**config** `WrapConfig | string`

If undefined, the internal key required will be grabbed from the `name` of the `work` function. If it does not have a name, the library will throw.

If a `string`, the internal key will be set to that string.

To customise your wrap further, you can send a `WrapConfig`:

- `key: string` The internal key to use.
- `timeout?: number` The timeout to wait for an external process to do the work before giving up and rejecting the promise.

**Returns** your wrapped function.

## Caveats

Keep in mind that this library can only deal with raw data; you can't make a database connection and magically share it with everyone. ;)

## Todo

- [ ] Detect if work is already happening locally and tap in to the local Promise rather than going to Redis.
- [ ] If a TTL of `0` is set, still look to Redis for locking and the receipt of data via pubsub, but never actually cache the data.
