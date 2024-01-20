// Overrides things like fetch & fs calls

import { createSimplePromise, getDataFromKey, jsonParseOrNull, stringMatchesKey } from './common.ts';
import { clearTimeout, setTimeout } from './time.ts';

const internalMarker = Symbol('#should_not_be_found#');

type FunctionToStubType = (...args: any[]) => unknown;
type StubKeyType = string | RegExp | undefined;
type FetchCallParameters = Parameters<typeof window['fetch']>;

interface GlobalStubOptions<FunctionToStub extends FunctionToStubType> {
	// function that injects/replaces the global/module ref
	replacer: (refHelper: FunctionToStub) => void;
	// interceptor for synchronous stubs
	interceptor?: (interceptorArguments: Parameters<FunctionToStub>) => unknown;
	// interceptor for asynchronous stubs
	asyncInterceptor?: (interceptorArguments: Parameters<FunctionToStub>) => Promise<unknown>;
}

/**
 * Low level stubbing helper. The StubDataType is intended to be used when a stubbed function takes strings as the first applicable argument
 *   for other functions (like fetch, which is more complex), an interceptor implementation should be provided
 * @param originalGlobalRef
 * @param options
 * @returns
 */
function createStubForRef<StubKey extends StubKeyType, StubDataType, FunctionToStub extends FunctionToStubType>(
	originalGlobalRef: FunctionToStub,
	options: GlobalStubOptions<FunctionToStub>,
) {
	type FunctionToSubArguments = Parameters<FunctionToStub>;

	// @ts-ignore internal check
	if (originalGlobalRef[internalMarker] === true) {
		throw new Error('An existing stub for this global was not cleared. Please check tests');
	}

	const stubDataMap = new Map<StubKey, StubDataType>();

	// For the async pathway, we need to await
	const stubbedFunction = options.asyncInterceptor
		? async function asyncStubbedFunction(...stubbedFunctionArguments: FunctionToSubArguments) {
			const overrideReturn = options.asyncInterceptor &&
				(await options.asyncInterceptor(stubbedFunctionArguments));
			return overrideReturn || getDataFromKey<StubDataType>(stubDataMap, stubbedFunctionArguments[0]) ||
				originalGlobalRef(stubbedFunctionArguments);
		}
		: function stubbedFunction(...stubbedFunctionArguments: FunctionToSubArguments) {
			const overrideReturn = options.interceptor && options.interceptor(stubbedFunctionArguments);
			return overrideReturn || getDataFromKey<StubDataType>(stubDataMap, stubbedFunctionArguments[0]) ||
				originalGlobalRef(stubbedFunctionArguments);
		};

	// replace the global with an assignment to the newly created stub above
	// @ts-ignore this is literally magic, calm down typescript
	options.replacer(stubbedFunction);

	return {
		/**
		 * Sets the return value of function being stubbed
		 * @param key
		 * @param value
		 */
		set(key: StubKey, value: StubDataType) {
			stubDataMap.set(key, value);
		},
		/**
		 * Clears all preset values
		 */
		clear() {
			stubDataMap.clear();
		},
		/**
		 * Replaces the stubbed function with the cleaned up function
		 */
		cleanup() {
			options.replacer(originalGlobalRef);
		},
	};
}

/**
 * Replaces Deno.readTextFile with basic stub implementation.
 * @returns
 */
export function stubReadTextFile() {
	return createStubForRef<string | RegExp, string, typeof Deno.readTextFile>(Deno.readTextFile, {
		replacer: (ref) => {
			Deno.readTextFile = ref;
		},
	});
}

interface FetchStubOptions {
	throwOnMissingIntercept?: boolean;
}

/**
 * Replaces fetch implementation with full interceptor support, enabling assertions
 * TODO: Potentially modularize this for re-use within other Deno projects
 * @param fetchStubOptions
 * @returns
 */
export function stubFetch(fetchStubOptions: FetchStubOptions = { throwOnMissingIntercept: true }) {
	// We get a little bit tricky here - we want to simulate the lease amount of the fetch API we need to
	// make tests, which in this case is simply .json();
	type FetchReturnType = {
		json: () => Promise<any>;
		text?: () => Promise<string>;
	};

	// The interface options
	interface InterceptOptions<RequestBodyShape> {
		match: (fetchArguments: FetchCallParameters, body?: RequestBodyShape) => RequestBodyShape | null;
		assertCallWithin?: number;
		// solely used to not lose my mind - helps trace if a match has failed assertions
		additionalContext?: unknown;
	}

	interface StoredInterception extends InterceptOptions<any> {
		resolvePromise: (value: FetchCallParameters | PromiseLike<FetchCallParameters>) => void;
		rejectPromise: (error: Error) => void;
		rejectTimeout?: ReturnType<typeof setTimeout>;
	}

	const pendingInterceptions = new Set<StoredInterception>();

	// Create a stub for this handler, but use interception instead of store-based replacement
	const fetchBaseStub = createStubForRef<StubKeyType, FetchReturnType, typeof window['fetch']>(globalThis['fetch'], {
		replacer: (ref) => {
			globalThis['fetch'] = ref;
		},
		// Implement interception core
		interceptor(fetchArguments) {
			// Attempt to pre-parse the JSON body for use by interceptors
			const fetchOptions = fetchArguments[1];
			const requestBody = typeof fetchOptions?.body === 'string'
				? jsonParseOrNull(fetchOptions.body)
				: fetchOptions?.body;

			for (const interceptionRef of pendingInterceptions) {
				// check the interception options, determine if it's a match (has return value)
				const matchedValue = interceptionRef.match(fetchArguments, requestBody);

				if (matchedValue) {
					// remove interceptor!
					pendingInterceptions.delete(interceptionRef);
					// clear reject timeout (if present)
					clearTimeout(interceptionRef.rejectTimeout);
					// queue resolve on the event loop
					setTimeout(() => interceptionRef.resolvePromise(fetchArguments));

					return createSimplePromise({
						json: () => createSimplePromise(matchedValue),
					});
				}
			}

			// We should sometimes throw on missing intercepts
			if (fetchStubOptions.throwOnMissingIntercept) {
				console.error(fetchArguments);
				throw new Error(`TEST ERROR - Fetch interception was not detected, aborting request`);
			}
		},
	});

	/**
	 * Intercepts calls to globalThis.fetch and intercepts the arguments. Allows overriding the response
	 * using the match option callback parameter.
	 * @param options
	 * @returns Promise that resolves with the fetch arguments (if called)
	 */
	function interceptRequest<RequestBodyShape = void>(
		options: InterceptOptions<RequestBodyShape>,
	): Promise<FetchCallParameters> {
		const shouldRejectTimeout = Boolean(options.assertCallWithin);

		// Create a basic interceptorRef
		const interceptionDataRef = {
			...options,
		} as Partial<StoredInterception>;

		// When the promise resolves, we want to resolve with request params
		const promiseToResolve = new Promise<FetchCallParameters>((resolve, reject) => {
			// Set the interceptor data by reference
			interceptionDataRef.resolvePromise = resolve;
			interceptionDataRef.rejectPromise = reject;

			// set timeout if rejectTimeout is set
			if (shouldRejectTimeout) {
				interceptionDataRef.rejectTimeout = setTimeout(() => {
					console.error(interceptionDataRef);
					reject(new Error('Maximum wait time exceeded for interceptor (see above)'));
				}, (options.assertCallWithin || 0) + 100);
			}
		});

		// Add interceptor reference to store
		pendingInterceptions.add(interceptionDataRef as StoredInterception);
		return promiseToResolve;
	}

	interface MatchRequestOptions<RequestBodyShape> {
		method?: 'GET' | 'POST';
		uri: string | RegExp;
		responseBody: (requestBody?: RequestBodyShape) => any;
		assertFetchArguments?: (fetchArgs: FetchCallParameters, requestBody?: RequestBodyShape) => void;
		assertCallWithin?: InterceptOptions<void>['assertCallWithin'];
	}

	/**
	 * A basic request matching helper - takes a uri as a regexp or string. Allows specifying the responseBody
	 * @param options
	 * @returns Promise that resolves with the fetch arguments (if called)
	 */
	function basicMatchRequest<RequestBodyShape>(
		options: MatchRequestOptions<RequestBodyShape>,
	) {
		// Create interceptor
		return interceptRequest<RequestBodyShape>({
			match([uri, requestOptions], requestBody) {
				// Validate request method
				const impliedRequestMethod = requestOptions?.method || 'GET';
				if (options.method && options.method !== impliedRequestMethod) {
					return null;
				}

				// Validate uri argument from fetch
				const normalizedUri = typeof uri === 'string' ? uri : uri.toString();
				if (!stringMatchesKey(normalizedUri, options.uri)) {
					return null;
				}

				// If provided, assert the fetch arguments BEFORE the code execution continues. Allows us to validate
				// specific settings (such as json body) were provided
				if (options.assertFetchArguments) {
					options.assertFetchArguments([uri, requestOptions], requestBody);
				}

				// Generate a response body depending on what was passed
				return options.responseBody(requestBody);
			},
			assertCallWithin: options.assertCallWithin,
			additionalContext: {
				uri: options.uri,
			},
		});
	}

	return {
		clear() {
			fetchBaseStub.clear();
		},
		cleanup() {
			// TODO: If interceptors dangle and don't throw for some reason, this would be where to detect them
			fetchBaseStub.cleanup();
		},
		interceptRequest,
		basicMatchRequest,
	};
}

export type StubFetchInstanceType = ReturnType<typeof stubFetch>;
