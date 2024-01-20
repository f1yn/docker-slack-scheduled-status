import { log } from './deps.ts';

import {
	findNextExpectedScheduledStatus,
	getExpectedStatusFromSchedule,
	reloadScheduleWithValidation,
	SelectedScheduleItem,
} from './schedule.ts';

import createTaskScheduler, { TaskSchedulerOptions } from './taskScheduler.ts';

import { loadCurrentStatusFromSlack, publishNewStatusToSlack } from './slack.ts';

interface RuntimeOptions {
	crashOnException?: TaskSchedulerOptions['crashOnException'];
}

/***
 * Create re-declarable closure scope (ideal for isolated usage like in tests & async runners)
 */
export function createRuntimeScope(options: RuntimeOptions = {}) {
	const taskSchedulerInterval = parseInt(
		Deno.env.get('SCHEDULER_INTERVAL_SECONDS') || '20',
	) as TaskSchedulerOptions['intervalInSeconds'];

	// state for for status
	let lastSetStatusById: string | null;

	// state for assertive move counter
	let assertiveIntervalCounter = 0;

	async function mainLoop() {
		// load and check existing slack schedule and look for updates
		const [slackSchedule, scheduleDidChange, knownIcons, settings] = await reloadScheduleWithValidation();

		// if new schedule is loading during this task run - reset the lastSetId
		if (scheduleDidChange) {
			lastSetStatusById = null;
		}

		// check the current expected status based on current time
		const currentExpectedStatus = getExpectedStatusFromSchedule(slackSchedule) as SelectedScheduleItem;

		let statusShouldReassert = false;

		if (settings.assertiveInterval && currentExpectedStatus.assertive) {
			// We've incremented to the max interval,so reset the status so we can check
			if (assertiveIntervalCounter === settings.assertiveInterval) {
				log.info(
					'[assertive] the currently expected status is assertive and we have reached the interval point. Forcing load for comparison',
				);
				assertiveIntervalCounter = 0;
				statusShouldReassert = true;
			} else {
				// increment
				assertiveIntervalCounter += 1;
			}
		}

		// if the expected status exactly matches what we last set, do nothing and exit task
		// if status was customised in Slack before the next interval becomes active - we can ignore
		if (!statusShouldReassert && lastSetStatusById && currentExpectedStatus.id === lastSetStatusById) {
			log.info('expected status already synchronized locally - skipping load/apply');
			return;
		}

		// check for empty status (we don't need to keep polling the Slack api)
		if (lastSetStatusById === '' && currentExpectedStatus.message === '') {
			log.info(
				`there are no scheduled status that apply right now, and we're locally synchronised - skipping load/apply`,
			);
			// show next potential schedule
			const [nextPotentialScheduledStatus, millisecondsUntilNextStatus] = findNextExpectedScheduledStatus(
				slackSchedule,
			);

			if (nextPotentialScheduledStatus) {
				const totalMinutesUntil = Math.floor(millisecondsUntilNextStatus / 60000);
				const hoursUntil = Math.floor(totalMinutesUntil / 60);
				const minutesUntil = totalMinutesUntil - hoursUntil * 60;
				log.info(
					`next expected status [${nextPotentialScheduledStatus.id}] expected in approximately ${hoursUntil}h ${minutesUntil}min`,
				);
			}
			return;
		}

		// fetch the last status and dnd state from Slack
		const currentSlackStatus = await loadCurrentStatusFromSlack();

		// detect if the Slack status does not include a known icon in our schedule
		// this is a limitation, but is much less expensive and fault-prone than comparing messages or assuming Slack will be
		// handling/serializing datetime values the same way Deno is (which is not well documented and likely subject to change)
		// if the schedule is assertive, do a similar check, but simply opt out if it's the same
		const isUsingUnrecognizedIcon = currentSlackStatus.icon && !knownIcons.includes(currentSlackStatus.icon);

		if (statusShouldReassert) {
			if (!isUsingUnrecognizedIcon) {
				log.info(
					'[assertive] the remote status is already compliant with the one we expect, so no need to override',
				);
				return;
			}
		} else if (isUsingUnrecognizedIcon) {
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
	}

	return createTaskScheduler({
		task: mainLoop,
		intervalInSeconds: taskSchedulerInterval,
		crashOnException: options.crashOnException,
	});
}

// Detect if we are a main module (running in podman)
if (import.meta.main) {
	// autostart execution if that's the case,otherwise assume we are headless and/or in-testing
	createRuntimeScope().start();
}
