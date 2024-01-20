import { FakeTime, FakeTimeInternals } from './deps.ts';

export type FixedTimepointInstanceType = ReturnType<typeof createFixedTimepoint>;

/**
 * Creates a FakeTime instance at a given day, month, and year
 * @param day Date in calendar index
 * @param month Month in calendar index
 * @param year
 * @returns
 */
export function createFixedTimepoint(day: number, month: number, year: number) {
	// create new date with absolute position (monday)
	const baseDate = new Date(year, month - 1, day - 1, 0, 1, 0, 1);
	const time = new FakeTime(baseDate);
	return time;
}

/**
 * On the current day, moves the FakeTime instance to a specific hour and day
 * @param time The FakeTime instance
 * @param clockTime 24h string representation of where to place the clock
 * @param daysToIncrement If required, increment the clock by a certain amount of days
 */
export function moveTimeToPosition(time: FakeTime, clockTime: string, daysToIncrement?: number) {
	// determine the desired hour and minute in 24 hour time
	const [hour, minute] = clockTime.split(':').map((item) => parseInt(item, 10));

	// Use the provided FakeTime instance to get the day and month
	const today = new Date();

	// Use the FakeTime setter instance and set the current time
	time.now = Number(
		new Date(
			today.getFullYear(),
			today.getMonth(),
			today.getDate() + (daysToIncrement || 0),
			hour,
			minute,
			0,
			1,
		),
	);
}

// Make sure we have stable references to original Deno internal timer stuff
export const setTimeout = FakeTimeInternals.setTimeout;
export const clearTimeout = FakeTimeInternals.clearTimeout;
export const setInterval = FakeTimeInternals.setInterval;
export const clearInterval = FakeTimeInternals.clearInterval;
