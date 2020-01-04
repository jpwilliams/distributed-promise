// public
import sigmund from 'sigmund'

export function generateObjectSignature (input: any, depth?: number): string {
	return sigmund(input, depth)
}
