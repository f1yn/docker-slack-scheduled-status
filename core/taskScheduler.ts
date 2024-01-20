import { log } from './deps.ts';

export interface TaskSchedulerOptions {
	intervalInSeconds: 1 | 2 | 3 | 4 | 5 | 6 | 10 | 15 | 20 | 30;
	task: () => Promise<void>;
	crashOnException?: boolean;
}

/**
 * Calculates the next possible interval and returns the time (in ms) until that interval becomes now
 *
 * Using this method helps prevent drift by making intervals relative to their intended target times instead
 * of relying on fixed intervals.
 */
function getMillisecondsUntilNextTask(intervalInSeconds: number): number {
	const currentTime = new Date();
	// calculate the next possible interval (Date will automatically wrap into the next minute - so stop there)
	const nextClosestInterval = new Date(
		currentTime.getFullYear(),
		currentTime.getMonth(),
		currentTime.getDate(),
		currentTime.getHours(),
		currentTime.getMinutes(),
	);
	// use the interval amount as a divisor - wrap up to the newest whole interval to determine the next possible seconds increment
	const currentSeconds = currentTime.getSeconds() + currentTime.getMilliseconds() / 1000;
	nextClosestInterval.setSeconds(Math.ceil(currentSeconds / intervalInSeconds) * intervalInSeconds);
	return nextClosestInterval.valueOf() - currentTime.valueOf();
}

/**
 * Creates an asynchronous executor that runs a task on a fixed interval.
 * To reduce code complexity, intervalInSeconds must be a even divisor of 60
 * @param intervalInSeconds 1,2,3,4,5,6,10,15,20, or 30
 * @param task
 */
export default function createTaskScheduler(options: TaskSchedulerOptions) {
	// store timeout id so we can cancel the scheduler if we need to
	let currentTimeout: number;

	async function executeTask(): Promise<void> {
		try {
			await options.task();
		} catch (taskExecutionError) {
			log.error(taskExecutionError);
			// We don't bubble on exceptions normally, but for testing we should allow this
			if (options.crashOnException) {
				throw taskExecutionError;
			}
		}
		const nextTaskMS = getMillisecondsUntilNextTask(options?.intervalInSeconds);
		currentTimeout = setTimeout(executeTask, nextTaskMS);
		log.debug(`next task executing in approx ${nextTaskMS} ms`);
	}

	return {
		/**
		 * Executes a single execution of the scheduler loop
		 * @returns
		 */
		executeTask: () => options.task(),
		/**
		 * Stops the further execution of a scheduler task
		 * @returns
		 */
		stop() {
			clearTimeout(currentTimeout);
			log.debug(`task executor stopped`);
			return this;
		},
		/**
		 * Starts the execution of a scheduler task
		 * @returns
		 */
		start() {
			executeTask();
			log.debug(`task scheduler started`);
			return this;
		},
	};
}
