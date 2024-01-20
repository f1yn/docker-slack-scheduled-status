import { setTimeout } from './time.ts';

/**
 * Creates a simple promise
 * @param data
 * @returns
 */
export function createSimplePromise<ResolveData>(
	data: ResolveData,
): Promise<ResolveData> {
	return new Promise((resolve) => resolve(data));
}

/**
 * Creates a shallow clone (useful in assertions) using JSON internals
 * @param jsonFriendlyData The data to clone
 * @returns The replicated object
 */
export function shallowClone<DataType = unknown>(jsonFriendlyData: DataType): DataType {
	return JSON.parse(JSON.stringify(jsonFriendlyData));
}

type DataMapKeyType = string | RegExp | undefined;

/**
 * Checks a string against a DataMapKey (string or Regexp)
 * @param value The value to test
 * @param testAgainst The test conditions (string as direct, regexp as well - regexp)
 * @returns The test result
 */
export function stringMatchesKey(value: string, testAgainst: DataMapKeyType): boolean {
	return (testAgainst instanceof RegExp && testAgainst.test(value)) ||
		(value === testAgainst);
}

/**
 * Iterate through the data map and check if any keys are matches (processes regular expressions)
 * This function, for the most part, only accounts for functions that are string based (no fancy post processing)
 * @param keyToCheck
 * @returns
 */
export function getDataFromKey<MapDataType>(
	dataMap: Map<DataMapKeyType, MapDataType>,
	keyToCheck: string,
): MapDataType | null {
	for (const [key, value] of dataMap) {
		if (stringMatchesKey(keyToCheck, key)) {
			return value;
		}
	}

	return null;
}

/**
 * Parses JSON if it can, otherwise returns null. Useful for fetch interceptors.
 * @param probablyJSONValue
 * @returns
 */
export function jsonParseOrNull(probablyJSONValue: string) {
	try {
		return JSON.parse(probablyJSONValue);
	} catch (_e) {
		// noop
	}
	return null;
}

/**
 * Wait a minimum amount of time on the event loop
 * @param timeInMs
 * @returns
 */
export function duration(timeInMs: number) {
	return new Promise((resolve) => setTimeout(() => resolve(null), timeInMs));
}

/**
 * @unused
 * Creates a handler for capturing async errors on the event loop that suddenly
 * stop propagating. At the end of tests, this gets executed.
 * @returns
 */
export function _captureEventLoopErrors() {
	const eventLoopErrors: Error[] = [];

	function onUnhandledRejection(e: PromiseRejectionEvent) {
		// Track the error
		eventLoopErrors.push(e.reason as Error);
		// Don't allow other code to track this exception
		e.preventDefault();
		e.stopImmediatePropagation();
	}

	globalThis.addEventListener('unhandledrejection', onUnhandledRejection);

	return {
		check() {
			if (!eventLoopErrors.length) return;

			console.error(`(${eventLoopErrors.length}) rejections detected`);

			eventLoopErrors.forEach((error, errorIndex) => {
				console.error(`(${errorIndex})`);
				console.error(error);
			});

			throw new Error(`(${eventLoopErrors.length}) rejections detected`);
		},
		cleanup() {
			// remove the handler
			globalThis.removeEventListener('unhandledrejection', onUnhandledRejection);
			// nudge gc
			eventLoopErrors.length = 0;
		},
	};
}
