import { log } from './deps.ts'

import {
    reloadScheduleWithValidation,
    getExpectedStatusFromSchedule, findNextExpectedScheduledStatus,
} from './schedule.ts';

import {
    loadCurrentStatusFromSlack,
    publishNewStatusToSlack,
} from './slack.ts';

const taskSchedulerInterval = parseInt(Deno.env.get('SCHEDULER_INTERVAL_SECONDS') || '20');

/**
 * Calculates the next possible interval and returns the time (in ms) until that interval becomes now
 *
 * Using this method helps prevent drift by making intervals relative to their intended target times instead
 * of relying on fixed intervals.
 */
function getMillisecondsUntilNextTask(intervalInSeconds : number) : number {
    const currentTime = new Date();
    // calculate the next possible interval (Date will automatically wrap into the next minute - so stop there)
    const nextClosestInterval = new Date(
        currentTime.getFullYear(),
        currentTime.getMonth(),
        currentTime.getDate(),
        currentTime.getHours(),
        currentTime.getMinutes()
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
export function createTaskScheduler(intervalInSeconds, task) {
    return async function executeTask(): Promise<void> {
        try {
            await task();
        } catch (taskExecutionError) {
            log.error(taskExecutionError);
        }
        const nextTaskMS = getMillisecondsUntilNextTask(intervalInSeconds);
        setTimeout(executeTask, nextTaskMS);
        log.debug(`next task executing in approx ${nextTaskMS} ms`);
    }
}


// statue for status
let lastSetStatusById;

createTaskScheduler(taskSchedulerInterval, async function() {
    // load and check existing slack schedule and look for updates
    const [slackSchedule, scheduleDidChange, knownIcons] = await reloadScheduleWithValidation();

    // if new schedule is loading during this task run - reset the lastSetId
    if (scheduleDidChange) {
        lastSetStatusById = null;
    }

    // check the current expected status based on current time
    const currentExpectedStatus = getExpectedStatusFromSchedule(slackSchedule);

    // if the expected status exactly matches what we last set, do nothing and exit task
    // if status was customised in Slack before the next interval becomes active - we can ignore
    if (lastSetStatusById && currentExpectedStatus.id === lastSetStatusById) {
        log.info('expected status already synchronised locally - skipping load/apply');
        return;
    }

    // check for empty status (we don't need to keep polling the Slack api)
    if (lastSetStatusById === '' && currentExpectedStatus.message === '') {
        log.info(`there are no scheduled status that apply right now, and we're locally synchronised - skipping load/apply`);
        // show next potential schedule
        const [nextPotentialScheduledStatus, millisecondsUntilNextStatus] = findNextExpectedScheduledStatus(slackSchedule);

        if (nextPotentialScheduledStatus) {
            const totalMinutesUntil = Math.floor(millisecondsUntilNextStatus / 60000);
            const hoursUntil = Math.floor(totalMinutesUntil / 60);
            const minutesUntil = totalMinutesUntil - hoursUntil * 60;
            log.info(`next expected status [${nextPotentialScheduledStatus.id}] expected in approximately ${hoursUntil}h ${minutesUntil}min`)
        }
        return;
    }

    // fetch the last status and dnd state from Slack
    const currentSlackStatus = await loadCurrentStatusFromSlack();

    // detect if the Slack status does not include a known icon in our schedule
    // this is a limitation, but is much less expensive and fault-prone than comparing messages or assuming Slack will be
    // handling/serializing datetime values the same way Deno is (which is not well documented and likely subject to change)
    if (currentSlackStatus.icon && !knownIcons.includes(currentSlackStatus.icon)) {
        log.info('unrecognized icon was set - skipping this scheduled status');
        // To prevent redundant lookups, set the lastSetStatusById to match the new status
        // this will make this script avoid overriding the status until the next scheduled status occurs
        // irl this would mean a user set a custom status and message
        lastSetStatusById = currentExpectedStatus.id;
        return;
    }

    if (!currentExpectedStatus.id && currentSlackStatus.message === '') {
        log.info(`remote status and local status are already empty - avoiding redundant request`);
        lastSetStatusById = currentExpectedStatus.id;
        return;
    }

    // attempt to publish new status to Slack
    await publishNewStatusToSlack(currentExpectedStatus, currentSlackStatus);
    // if the status was set successfully - cache this status
    lastSetStatusById = currentExpectedStatus.id;
    log.info(`new status was applied ${lastSetStatusById || '[[empty]]'}`);
})();
