import { log, parseToml } from './deps.ts';

// Allow non English-locales
const locale = Deno.env.get('LOCALE') || 'en-US';

// compute schedule two whole days (24 hours max duration of events)
// accounts for scheduled status that lapse from yesterday into today
const maximumDaySpan = parseInt(Deno.env.get('SCHEDULER_MAX_DAYSPAN') || '2');

interface PreprocessedScheduleItem {
	start: string;
	end?: string;
	duration?: string;
	icon: string;
	message: string[] | string;
	days: string[] | string;
	doNotDisturb?: boolean;
	assertive?: boolean;
}

interface ScheduleSettings {
	ignoredIcons?: string[];
	assertiveInterval?: number;
}

export interface ScheduleItem {
	id: string;
	startTime: Date;
	endTime: Date;
	icon: string;
	message: string[] | string;
	validWeekdays: string[];
	doNotDisturb: boolean;
	assertive: boolean;
}

export interface SelectedScheduleItem extends ScheduleItem {
	message: string;
}

export type PreprocessedSchedule = {
	[key: string]: PreprocessedScheduleItem;
};

type SlackSchedule = ScheduleItem[];

// Compute all named days of the week, but using the locale provided above
const SCHEDULE_EVERYDAY = [0, 1, 2, 3, 4, 5, 6].map((dayOffset) => {
	const date = new Date(1996, 0, 1 + dayOffset);
	// correct for timezone drift (try and get UTC)
	date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
	return date.toLocaleString(locale, { weekday: 'short' }).toLowerCase();
});

// Get 5-day workweek alias days
const SCHEDULE_WEEKDAYS = SCHEDULE_EVERYDAY.filter((_i, index) => index && index < 6);

// Get 4-day workweek alias days
const SCHEDULE_4D = SCHEDULE_EVERYDAY.filter((_i, index) => index && index < 5);

let lastLoadedRawToml: string;
let lastLoadedParsedToml: { [key: string]: any };

/**
 * Converts an unrefined days value from the schedule.toml into a usable set of weekdays
 * @param weekdayValue
 */
function determineValidWeekdaysForSchedule(weekdayValue: string | string[]): string[] {
	if (weekdayValue === 'everyday') return Array.from(SCHEDULE_EVERYDAY);
	if (weekdayValue === 'weekdays') return Array.from(SCHEDULE_WEEKDAYS);
	if (weekdayValue === '4D') return Array.from(SCHEDULE_4D);

	if (!Array.isArray(weekdayValue)) return [];

	// otherwise, parse the presented weekdays
	return weekdayValue
		// do our best to stringify potentially bad toml
		.map((rawValue) => `${rawValue}`.toLowerCase())
		// check it against known localized days of the week
		.filter((value) => SCHEDULE_EVERYDAY.includes(value));
}

/**
 * Destructures and filters items in the parsed. Returns a boolean flag if the last loaded schema does not match
 * @param rawScheduleToml
 * @returns
 */
function parseAndFilterSchedule(rawScheduleToml: string): [PreprocessedSchedule, ScheduleSettings, boolean] {
	// Detect if we detected a potential schedule rewrite (or hasn't been parsed yet
	const scheduleDidChange = rawScheduleToml !== lastLoadedRawToml;

	if (scheduleDidChange) {
		lastLoadedParsedToml = parseToml(rawScheduleToml);
		lastLoadedRawToml = rawScheduleToml;
	}

	// separate the settings early-on so we can use them to alter any calculations we might need to do
	const {
		settings,
		...preprocessedSchedule
	} = lastLoadedParsedToml;

	// TODO: early filtering/default settings here

	return [preprocessedSchedule, settings || {}, scheduleDidChange];
}

/**
 * Loads schedule.toml from the filesystem, attempt to parse and will return the parsed files
 */
export async function reloadScheduleWithValidation(): Promise<[SlackSchedule, boolean, string[], ScheduleSettings]> {
	const [
		unprocessedSchedule,
		settings,
		scheduleDidChange,
	] = parseAndFilterSchedule(
		// Always read the most recent schedule from the fs
		await Deno.readTextFile('/schedule.toml'),
	);

	// it's possible for a single schedule to span multiple days, so it's often cheaper computationally
	// to iterate over the entire computed list
	const processedSchedule = [] as ScheduleItem[];
	const recognizedIcons = new Set<string>();

	// get relevant date values
	const currentTime = new Date();
	const currentYear = currentTime.getFullYear();
	const currentMonth = currentTime.getMonth();
	const currentDate = currentTime.getDate();

	for (const [id, itemRef] of Object.entries(unprocessedSchedule)) {
		if (!itemRef.icon) {
			log.warning(`Scheduled status without icons are not supported (check the status [${id}] for issues)`);
			continue;
		}

		// create the list of week days that this schedule will be valid - validate that the schedule is valid
		const validWeekdays = determineValidWeekdaysForSchedule(itemRef.days);
		if (!validWeekdays.length) {
			log.warning(
				`No valid weekdays or alias could be determined from this item (check the status [${id}] for issues)`,
			);
			log.warning(
				`(hint): LOCALE is set to "${locale}" and supported values are ${SCHEDULE_EVERYDAY.join(', ')}`,
			);
			continue;
		}

		// parse the toml date values to integers (prevent 24 hours times from creating abominable values)
		const [startHour, startMinute, startSecond] = itemRef.start.split(':').map((v) => parseInt(v));
		const [finalHour, finalMinute, finalSecond] = (itemRef.duration || itemRef.end || '').split(':').map((v) =>
			parseInt(v)
		);

		// skip items that have improper durations
		if (itemRef.duration && finalHour > (maximumDaySpan - 1) * 24) {
			log.warning(`While possible, schedule items spanning more than ${2} days can causes weird behaviors.`);
			log.warning(`Please correct this (check the status [${id}] for issues)`);
			continue;
		}

		// start iterating through each day span (currently two days max)
		let dayOffset = maximumDaySpan;

		while (dayOffset--) {
			// generate base start time
			const startTime = new Date(
				currentYear,
				currentMonth,
				currentDate - dayOffset,
				startHour,
				startMinute,
				startSecond,
			);
			// determine the  end time for this scheduled status
			const endTime = itemRef.duration
				// if a duration is present then apply list to the start time
				? new Date(
					currentYear,
					currentMonth,
					currentDate - dayOffset,
					startHour + finalHour,
					startMinute + finalMinute,
					startSecond + finalSecond,
				)
				// otherwise, treat as an exact (same-day) end time
				: new Date(currentYear, currentMonth, currentDate - dayOffset, finalHour, finalMinute, finalSecond);

			processedSchedule.push({
				id,
				startTime,
				endTime,
				icon: itemRef.icon,
				message: Array.isArray(itemRef.message) ? itemRef.message : [itemRef.message],
				doNotDisturb: Boolean(itemRef.doNotDisturb),
				validWeekdays,
				assertive: Boolean(itemRef.assertive),
			});
		}

		// save this icon, so we can do a cheap check later on in the primary task loop (is the current status unknown)
		recognizedIcons.add(itemRef.icon);
	}

	// make sure that ignored icons are added to recognized icons (avoid override)
	for (const icon of (settings.ignoredIcons || [])) {
		recognizedIcons.add(icon);
	}

	return [processedSchedule, scheduleDidChange, Array.from(recognizedIcons), settings];
}

/**
 * Returns the most relevant scheduled status if it matches the current time window
 * @param schedule
 */
export function getExpectedStatusFromSchedule(schedule: SlackSchedule): SelectedScheduleItem | { id: null } {
	const currentTime = new Date();
	const currentWeekday = currentTime.toLocaleString(locale, { weekday: 'short' }).toLowerCase();

	const matchingScheduleItems = schedule.filter((item) =>
		// find any schedule items that are within the currentTime
		item.startTime <= currentTime &&
		item.endTime > currentTime &&
		// is on a matching weekday
		item.validWeekdays.includes(currentWeekday)
	);

	// The current time is not within any schedule we can see so return null-time
	if (!matchingScheduleItems.length) {
		return {
			id: null,
		};
	}

	if (matchingScheduleItems.length > 1) {
		// Sort the potential matches to include the smallest possible window
		matchingScheduleItems.sort((a, b) => {
			const scheduleDurationA = Number(a.endTime) - Number(a.startTime);
			const scheduleDurationB = Number(b.endTime) - Number(b.startTime);
			return scheduleDurationA - scheduleDurationB;
		});
	}

	// select random message
	const [finalMatchRef] = matchingScheduleItems;
	const randomMessageIndex = Math.round((finalMatchRef.message.length - 1) * Math.random());

	return {
		...finalMatchRef,
		message: finalMatchRef.message[randomMessageIndex],
	};
}

/**
 * When no schedule is active, we can find the closest next schedule
 * @returns A tuple containing the next potential scheduled status, and the number of
 *    milliseconds until it's expected to take place. If no expected status can be found, it returns null
 * @param schedule
 */
export function findNextExpectedScheduledStatus(schedule: SlackSchedule): [ScheduleItem, number] | [null, null] {
	const currentTime = new Date();
	const currentWeekday = currentTime.toLocaleString(locale, { weekday: 'short' }).toLowerCase();

	// Get all currently for-seen scheduled events that will happen in the future
	const allNextPotentialScheduledStatus = schedule
		.filter((item) =>
			item.startTime > currentTime &&
			item.validWeekdays.includes(currentWeekday)
		);

	if (allNextPotentialScheduledStatus.length) {
		allNextPotentialScheduledStatus.sort((a, b) => {
			const distanceUntilEventA = Number(a.startTime) - Number(currentTime);
			const distanceUntilEventB = Number(b.startTime) - Number(currentTime);
			return distanceUntilEventA - distanceUntilEventB;
		});

		const [nextPotentialStatus] = allNextPotentialScheduledStatus;
		return [nextPotentialStatus, Number(nextPotentialStatus.startTime) - Number(currentTime)];
	}

	return [null, null];
}
