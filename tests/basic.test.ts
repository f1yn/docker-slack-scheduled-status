import { assertArrayIncludes, assertEquals, assertGreaterOrEqual } from './internal/deps.ts';
import { stubFetch, stubReadTextFile } from './internal/stubs.ts';
import { createFixedTimepoint, moveTimeToPosition } from './internal/time.ts';
import createSlackActionsApi from './slack.ts';

Deno.test('Simple schedule test', async () => {
	const helpers = await basicTestSetup(`
[first-status]
start = 16:00:00
end = 17:00:00
icon = ":test:"
message = [
    "This is my test status message",
    "This is another possible status message"
]
days = ["Mon", "Tue", "Wed", "Thu", "Fri"]
doNotDisturb = true

[second-status]
start = 18:00:00
end = 20:00:00
icon = ":test2:"
message = [
    "EEEEEE",
    "AAAAAAH"
]
days = ["Tue", "Wed", "Thu", "Fri"]
    `);

	const { time, runtime } = helpers;

	try {
		// set a specific time that we know
		moveTimeToPosition(time, '16:03');

		// Queue the requests we expect to intercept - note that missing requests will fail the test
		const userInfoRequest1 = helpers.slackApi.getProfileRequest();
		const dndInfoRequest1 = helpers.slackApi.getDndInfoRequest();
		const userSetRequest1 = helpers.slackApi.updateProfileRequest();
		const dndSetRequest1 = helpers.slackApi.setDndSnoozeRequest();

		// First cycle iteration
		await Promise.all([
			runtime.executeTask(),
			userInfoRequest1,
			dndInfoRequest1,
			userSetRequest1,
			dndSetRequest1,
		]);

		// Verify that the expected values were set
		helpers.slackApi.assert((state) => {
			assertEquals(state.statusEmoji, ':test:');
			assertGreaterOrEqual(state.statusExpiration!, 820500000);
			assertEquals(state.dndDurationMinutes, 56);
			assertArrayIncludes([
				'This is my test status message',
				'This is another possible status message',
			], [state.statusText]);
		});

		// move time to empty allocation (status should unset)
		moveTimeToPosition(helpers.time, '17:30');

		// Again, queue the requests we expect to intercept
		const userInfoRequest2 = helpers.slackApi.getProfileRequest();
		const dndInfoRequest2 = helpers.slackApi.getDndInfoRequest();
		const userSetRequest2 = helpers.slackApi.updateProfileRequest();
		const dndEndRequest2 = helpers.slackApi.endDndSnoozeRequest();

		// Second iteration (should empty status, and end DnD)
		await Promise.all([
			runtime.executeTask(),
			userInfoRequest2,
			dndInfoRequest2,
			userSetRequest2,
			dndEndRequest2,
		]);

		// Verify that mocked Slack api has unset state
		helpers.slackApi.assert((state) => {
			assertEquals(state.statusEmoji, null);
			assertEquals(state.statusExpiration, null);
			assertEquals(state.dndDurationMinutes, 0);
			assertEquals(state.statusText, '');
		});

		// move time to next allocation (no overlap because it should be monday)
		moveTimeToPosition(helpers.time, '18:10');

		// Queue the requests we expect to intercept
		const userInfoRequest3 = helpers.slackApi.getProfileRequest();
		const dndInfoRequest3 = helpers.slackApi.getDndInfoRequest();

		// Perform work cycle
		await Promise.all([
			runtime.executeTask(),
			userInfoRequest3,
			dndInfoRequest3,
		]);

		// Verify that mocked Slack api has unset state
		helpers.slackApi.assert((state) => {
			assertEquals(state.statusEmoji, null);
			assertEquals(state.statusExpiration, null);
			assertEquals(state.dndDurationMinutes, 0);
			assertEquals(state.statusText, '');
		});

		// move time to 19:00 hours on the following day (should be Tuesday)
		moveTimeToPosition(helpers.time, '19:00', 1);

		const userInfoRequest4 = helpers.slackApi.getProfileRequest();
		const dndInfoRequest4 = helpers.slackApi.getDndInfoRequest();
		const userSetRequest4 = helpers.slackApi.updateProfileRequest();

		await Promise.all([
			runtime.executeTask(),
			userInfoRequest4,
			dndInfoRequest4,
			userSetRequest4,
		]);

		helpers.slackApi.assert((state) => {
			assertEquals(state.statusEmoji, ':test2:');
			assertGreaterOrEqual(state.statusExpiration!, 820600000);
			assertEquals(state.dndDurationMinutes, 0);
			assertArrayIncludes([
				'EEEEEE',
				'AAAAAAH',
			], [state.statusText]);
		});

		// await duration(1000);
	} catch (error) {
		throw error;
	} finally {
		console.log('cleanup');
		helpers.cleanup();
	}
});

async function basicTestSetup(
	scheduleTomlFile: string,
) {
	// Setup stubs (clean after test)
	const time = createFixedTimepoint(2, 1, 1996);
	const fetchStub = stubFetch();
	const readFileStub = stubReadTextFile();

	// Create fake secret and stub
	readFileStub.set(`/run/secrets/slack_status_scheduler_user_token`, 'slack_status_scheduler_user_token');
	// Create toml schedule representation and stub
	readFileStub.set('/schedule.toml', scheduleTomlFile);

	// create mock Slack api
	const slackApi = createSlackActionsApi(fetchStub);

	// load runtime as import module
	const runtimeModule = await import('../core/runtime.ts');
	const runtime = runtimeModule.createRuntimeScope({ crashOnException: true });

	return {
		runtime,
		time,
		fetchStub,
		slackApi,
		readFileStub,
		cleanup() {
			// runtime?.stop();
			time.restore();
			fetchStub.cleanup();
			readFileStub.cleanup();
		},
	};
}
