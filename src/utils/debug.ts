// core
import { resolve as resolvePath, relative as relativePath } from 'path'

// public
import callsites from 'callsites'
import Debug from 'debug'

const prefix = 'distributedpromise'
const cwd = resolvePath(__dirname, '../')

export function debug (formatter: any, ...args: any[]): void {
	const stack = callsites()
	stack.shift()

	const dir = relativePath(cwd, stack[0].getFileName() ?? '')
	const namespace = `${prefix}:${dir}`
	const log = Debug(namespace)

	if (!log.enabled) return

	let nearestFn = ''

	for (let i = 0; i < stack.length; i++) {
		const hasPath = Boolean(stack[i].getFileName())
		if (!hasPath) continue

		const fnName = stack[i].getFunctionName()

		if (fnName) {
			nearestFn = fnName
			break
		}

		const typeName = stack[i].getTypeName()

		if (typeName) {
			nearestFn = `${typeName}${stack[i].isConstructor() ? '' : `.${stack[i].getMethodName() || '<anonymous>'}`}`
			break
		}
	}

	const name = `${namespace} ${nearestFn}`
	log.namespace = name

	log(formatter, ...args)
}
