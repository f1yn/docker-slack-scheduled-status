import { StubFetchInstanceType } from './internal/stubs.ts';
import { shallowClone } from './internal/common.ts';
import { SlackDndDataSend, SlackProfileDataSend } from '../core/slack.ts';

export type SlackActionsApiInstanceType = ReturnType<typeof createSlackActionsApi>;

/**
 * Create mocked representation of Slack service
 * @param fetchStub
 */
export default function createSlackActionsApi(fetchStub: StubFetchInstanceType) {
	interface SlackState {
		statusEmoji: string | null;
		statusExpiration: number | null;
		statusText: string;
		dndDurationMinutes: number;
	}

	const slackState: SlackState = {
		statusEmoji: null,
		statusExpiration: 0,
		statusText: '',
		dndDurationMinutes: 0,
	};

	const getProfileState = () => ({
		profile: {
			status_emoji: slackState.statusEmoji,
			status_expiration: slackState.statusExpiration,
			status_text: slackState.statusText,
		},
	});

	return {
		getProfileRequest() {
			return fetchStub.basicMatchRequest({
				uri: 'https://slack.com/api/users.profile.get',
				responseBody: getProfileState,
				assertCallWithin: 2000,
			});
		},
		updateProfileRequest() {
			return fetchStub.basicMatchRequest<SlackProfileDataSend>({
				uri: 'https://slack.com/api/users.profile.set',
				method: 'POST',
				responseBody: (body) => {
					slackState.statusEmoji = body?.profile.status_emoji || null;
					slackState.statusExpiration = body?.profile.status_expiration || null;
					slackState.statusText = body?.profile.status_text || '';
					return getProfileState();
				},
				assertCallWithin: 2000,
			});
		},
		getDndInfoRequest() {
			return fetchStub.basicMatchRequest({
				uri: 'https://slack.com/api/dnd.info',
				responseBody: () => ({
					num_minutes: slackState.dndDurationMinutes,
					snooze_enabled: Boolean(slackState.dndDurationMinutes),
				}),
				assertCallWithin: 2000,
			});
		},
		setDndSnoozeRequest() {
			return fetchStub.basicMatchRequest<SlackDndDataSend>({
				uri: 'https://slack.com/api/dnd.setSnooze',
				method: 'POST',
				responseBody: (body) => {
					slackState.dndDurationMinutes = body?.num_minutes || 0;
					return {
						ok: true,
					};
				},
				assertCallWithin: 2000,
			});
		},
		endDndSnoozeRequest() {
			return fetchStub.basicMatchRequest<SlackDndDataSend>({
				uri: 'https://slack.com/api/dnd.endSnooze',
				method: 'POST',
				responseBody: () => {
					slackState.dndDurationMinutes = 0;
					return {
						ok: true,
					};
				},
				assertCallWithin: 2000,
			});
		},
		assert(assertCallback: (slackState: SlackState) => void) {
			// We want to avoid the temptation to mutate the original ref, so return a shallow clone
			assertCallback(shallowClone(slackState));
		},
	};
}
