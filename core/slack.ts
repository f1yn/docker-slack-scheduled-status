import { log } from './deps.ts';

import { ScheduleItem } from "./schedule.ts";

const slackUserToken = await loadSecret(Deno.env.get('SLACK_USER_TOKEN_KEYID') || 'slack_status_scheduler_user_token');

interface CurrentSlackStatus {
    message: string,
    icon: string,
    doNotDisturb: boolean
}

/**
 * Convenience wrapper around Deno-fetch that will either `GET` or `POST` to the Slack api with
 * the correct headers/credentials
 * @param uri
 * @param bodyToSend
 */
async function fetchOrSubmitJson(uri: string, bodyToSend = null) {
    try {
        const options = {
            headers: {
                Authorization: `Bearer ${slackUserToken}`,
                'Content-Type': 'application/json; charset=utf-8',
            }
        }

        if (bodyToSend) {
            options.method = 'POST';
            options.body = JSON.stringify(bodyToSend);
        }

        const result = (await fetch(uri, options)).json();
        if (result.error) throw new Error(result.error);
        return result;
    } catch (requestOrParseError) {
        // override error message for debug
        requestOrParseError.message = [
            'Error requesting or parsing resource', uri, requestOrParseError.message
        ].join(' ');

        throw requestOrParseError;
    }
}

export async function loadCurrentStatusFromSlack() : Promise<CurrentSlackStatus> {
    const [profileData, dndInfo] = await Promise.all([
        // Slack user profile
        fetchOrSubmitJson('https://slack.com/api/users.profile.get'),
        // Slack user Do Not Disturb status
        fetchOrSubmitJson('https://slack.com/api/dnd.info'),
    ]);

    return {
        message: profileData.profile.status_text,
        icon: profileData.profile.status_emoji,
        doNotDisturb: dndInfo.snooze_enabled,
    }
};

export async function publishNewStatusToSlack(scheduleItem : ScheduleItem, existingStatus : CurrentSlackStatus) {
    // If the status has an endTime, get the expiry in unix-timestamp, otherwise unset expiry
    const status_expiration = scheduleItem.endTime ? Math.round(scheduleItem.endTime.getTime() / 1000) : 0;

    await fetchOrSubmitJson('https://slack.com/api/users.profile.set', {
        profile: {
            status_emoji: scheduleItem.icon,
            status_text: scheduleItem.message,
            status_expiration,
        }
    });

    if (scheduleItem.doNotDisturb && !existingStatus.doNotDisturb) {
        // enable do not disturb for this status - just to be safe - also set a duration so if the server goes down DnD
        // won't last indefinitely
        const currentTime = new Date();
        const dndDurationInMinutes = Math.floor( (scheduleItem.endTime - currentTime) / 60000);

        log.info(`Attempting to enable Slack DnD for [${scheduleItem.id}] = ${dndDurationInMinutes} minutes`);
        // Slack decided DnD was not using REST-ful design (weird)
        const result = await fetchOrSubmitJson(`https://slack.com/api/dnd.setSnooze?num_minutes=${dndDurationInMinutes}`);

        if (result.ok) {
            log.info('Slack DnD was set successfully');
        } else {
            log.error('Slack DnD request failed')
            log.error(result);
        }
    } else if (!scheduleItem.doNotDisturb && existingStatus.doNotDisturb) {
        // disable do not disturb
        // even though this could be potentially annoying, it's better to do this than accidentally leave DnD on
        log.info('Attempting to disable Slack DnD')
        const result = await fetchOrSubmitJson('https://slack.com/api/dnd.endSnooze', {});

        if (result.ok) {
            log.info('Slack DnD was disabled successfully');
        } else {
            log.error('Slack DnD disable request failed')
            log.error(result);
        }
    }
};

async function loadSecret(secretId: string) : Promise<string> {
    try {
        return Deno.readTextFile(`/run/secrets/${secretId}`);
    } catch (fsError) {
        const errorMessage = fsError.code === 'ENOENT' ?
            'as it was not provided. Make sure your container has the correct secrets defined.' :
            'due to an unexpected error';
        // override original error message for debug
        fsError.message = ['Failed to load', secretId, errorMessage, '(original):', fsError.message].join(' ');
        throw fsError;
    }
}