import { log, parseToml } from './deps.ts';

// Allow non English-locales
const locale = Deno.env.get('LOCALE') || 'en-US';

// compute schedule two whole days (24 hours max duration of events)
// accounts for scheduled status that lapse from yesterday into today
const maximumDaySpan = parseInt(Deno.env.get('SCHEDULER_MAX_DAYSPAN') || '2');

export interface ScheduleItem {
    id: string,
    startTime: Date,
    endTime: Date,
    icon: string,
    message: string[] | string,
    validWeekdays: [],
    doNotDisturb: boolean,
}

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

let lastLoadedRawToml : string;
let lastLoadedParsedToml;

/**
 * Converts an unrefined days value from the schedule.toml into a usable set of weekdays
 * @param weekdayValue
 */
function determineValidWeekdaysForSchedule(weekdayValue : string | string[]) : string[] {
    if (weekdayValue === 'everyday') return Array.from(SCHEDULE_EVERYDAY);
    if (weekdayValue === 'weekdays') return Array.from(SCHEDULE_WEEKDAYS);
    if (weekdayValue === '4D') return Array.from(SCHEDULE_4D);

    if (!Array.isArray(weekdayValue)) return [];

    // otherwise, parse the presented weekdays
    return weekdayValue
        // do our best to stringify potentially bad toml
        .map((rawValue) => `${rawValue}`.toLowerCase())
        // check it against known localised days of the week
        .filter((value) => SCHEDULE_EVERYDAY.includes(value))
}

/**
 * Loads schedule.toml from the filesystem, attempt to parse and will return the parsed files
 */
export async function reloadScheduleWithValidation() : Promise<[SlackSchedule, boolean, string[]]> {
    // Always read the most recent schedule from the fs
    const rawToml = await Deno.readTextFile('/schedule.toml');

    // Detect if we detected a potential schedule rewrite (or hasn't been parsed yet
    const scheduleDidChange = rawToml !== lastLoadedRawToml;

    if (scheduleDidChange) {
        lastLoadedParsedToml = parseToml(rawToml);
        lastLoadedRawToml = rawToml;
    }

    // it's possible for a single schedule to span multiple days, so it's often cheaper computationally
    // to iterate over the entire computed list
    const processedSchedule = [];
    const recognizedIcons = new Set();

    // get relevant date values
    const currentTime = new Date();
    const currentYear = currentTime.getFullYear();
    const currentMonth = currentTime.getMonth();
    const currentDate = currentTime.getDate();

    for (const id of Object.keys(lastLoadedParsedToml)) {
        const itemRef = lastLoadedParsedToml[id];

        if (!itemRef.icon) {
            log.warn(`Scheduled status without icons are not supported (check the status [${id$}] for issues)`);
            continue;
        }

        // create the list of week days that this schedule will be valid - validate that the schedule is valid
        const validWeekdays = determineValidWeekdaysForSchedule(itemRef.days);
        if (!validWeekdays.length) {
            log.warn(`No valid weekdays or alias could be determined from this item (check the status [${id}] for issues)`);
            log.warn(`(hint): LOCALE is set to "${locale}" and supported values are ${SCHEDULE_EVERYDAY.join(', ')}`);
            continue;
        }

        // parse the toml date values
        const [startHour, startMinute, startSecond] = itemRef.start.split(':');
        const [finalHour, finalMinute, finalSecond] = (itemRef.duration || itemRef.end).split(':');

        // skip items that have improper durations
        if (itemRef.duration && finalHour > (maximumDaySpan - 1) * 24) {
            log.warn(`While possible, schedule items spanning more than ${totalDaySpan} days can causes weird behaviors.`);
            log.warn(`Please correct this (check the status [${id}] for issues)`);
            continue;
        }

        // start iterating through each day span (currently two days max)
        let dayOffset = maximumDaySpan;

        while (dayOffset--) {
            // generate base start time
            const startTime = new Date(currentYear, currentMonth, currentDate - dayOffset, startHour, startMinute, startSecond);
            // determine the  end time for this scheduled status
            const endTime = itemRef.duration ?
                // if a duration is present then apply it to the start time
                new Date(currentYear, currentMonth, currentDate - dayOffset, startHour + finalHour, startMinute + finalMinute, startSecond + finalSecond) :
                // otherwise, treat as an exact (same-day) end time
                new Date(currentYear, currentMonth, currentDate - dayOffset, finalHour, finalMinute, finalSecond);

            processedSchedule.push({
                id,
                startTime,
                endTime,
                icon: itemRef.icon,
                message: Array.isArray(itemRef.message) ? itemRef.message : [itemRef.message],
                doNotDisturb: Boolean(itemRef.doNotDisturb),
                validWeekdays,
            })
        }

        // save this icon, so we can do a cheap check later on in the primary task loop (is the current status unknown)
        recognizedIcons.add(itemRef.icon);
    }

    return [processedSchedule, scheduleDidChange, Array.from(recognizedIcons)];
}

/**
 * Returns the most relevant scheduled status if it matches the current time window
 * @param schedule
 */
export function getExpectedStatusFromSchedule(schedule: SlackSchedule) : ScheduleItem {
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
            id: '',
            icon: '',
            message: '',
            validWeekdays: [],
            doNotDisturb: false,
        }
    }

    if (matchingScheduleItems.length > 1) {
        // Sort the potential matches to include the smallest possible window
        matchingScheduleItems.sort((a, b) => {
            const scheduleDurationA = a.endTime - a.startTime;
            const scheduleDurationB = b.endTime - b.startTime;
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
export function findNextExpectedScheduledStatus(schedule: SlackSchedule) : Array<ScheduleItem, number>|Array<null,null> {
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
           const distanceUntilEventA = a.startTime - currentTime;
           const distanceUntilEventB = b.startTime - currentTime;
           return distanceUntilEventA - distanceUntilEventB;
        });

        const [nextPotentialStatus] = allNextPotentialScheduledStatus;
        return [nextPotentialStatus, nextPotentialStatus.startTime - currentTime];
    }

    return [null, null];
}