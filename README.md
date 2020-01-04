# @jpwilliams/distributed-promise

Distribute a promise across multiple processes connected via Redis.

``` sh
npm install --save @jpwilliams/distributed-promise
```

``` ts
import { DistributedPromiseWrapper } from '@jpwilliams/distributed-promise'

// a promise
async function joinStr (...strs) {
	return strs.join()
}

// create a distributed promise via Redis
const wrapper = new DistributedPromiseWrapper({
	redis: myRedisClient
})

const joinStrShared = wrapper.wrap(joinStr)

// use it!
const result = await joinStrShared('foo', 'bar')
```

- Can we detect if the work is happening in the same process as us and skip going to Redis at all?
