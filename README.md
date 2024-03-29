# Slack Scheduled Status for Docker

This is a lightweight, containerized way to update your Slack status based on a schedule.

- Supports scheduled status spanning multiple days (up to 24 hours, can be extended with environment variables)
- Supports nested scheduled status (i.e 21:00 to 23:30, but also 22:00 to 23:00 on the same day)
- Supports randomized message selection to make your statues more personable
- Supports synchronizing Slack Do Not Disturb state (this is not a replacement for manually checking status)

## Getting started

You will need:

- A server, either self-hosted or cloud-based, capable or running secured containers (via Docker or Podman).
- To create a small Slack application with the necessary scope to read and write to a specific user profile
- The patience to make sure your containers (and the host they run on) has adequate uptime.

## Creating a Slack app solely for updating status

> Somewhat tedious but also straightforward - **full article w/ instructions is pending**

When creating the personal Slack app, the following OAuth **User Token Scopes** permissions are required:

- **dnd:read**
- **dnd:write**
- **users.profile:read**
- **users.profile:write**

> Note that because this is a personal application, only the user who owns the app will authenticate with this.

If you know in advance that you'll be using a fixed IPv4 address for your host, it is worthwhile to add that address to
the **Allowed IP Address Ranges** section.

## Create a schedule

This scheduler uses a toml format, which has the following rules:

- `icon`, `start`, `message`, and `days` must be present
- `days` can be `"weekdays"`, or `"everyday"`, but can also be an array of short-named days
  in the local of the server - uses `Date.prototype.toLocaleString('your-server-locale', { weekday: 'short' })`
- Each item (toml table) name must be unique
- `start` must be provided as a 24h time
- `end` can be provided as a 24h time on the same day, while `duration` can be used for statuses that span over multiple days

```toml
# The id of the scheduled status
[my-scheduled-status]
# The starting time relative to the host running the scheduler
start = 16:00:00
# The ending time relative to the host running the scheduler
end = 17:00:00
# The slack icon to show on your status
icon = ":test:"
# A set of messages to set the status to
message = [
    "This is my test status message",
    "This is another possible status message"
]
# An alias or set of days that this schedule will apply relative to the host running the scheduler
days = ["Mon", "Tue", "Wed", "Thu"]
# Will set the Slack profile to "Do Not Disturb" when set. Will unset once this scheduled period is complete
doNotDisturb = true
# Will assert it's satus if an invalid state is detected (needs assertiveInterval in settings to be enabled). This is
# most useful for longer statues that might be disabled, but are tedious to re-enable by hand if overridden in slack.
assertive = false
```

## Additional settings
A `[settings]` area can be added with the following settings:

```toml
[settings]
# Ignored icons will not override the next scheduled status (i.e focus time statues, grabbing a bite, .e.c.t)
ignoredIcons = [':icon1:', ':icon2:']
# Enables assertive mode, allowing the ability to re-apply marked scheduled items when `assertive: true` is passed.
# Value is a numeric interval of the SCHEDULER_INTERVAL_SECONDS value (i.e a value of 3 will trigger an assertion (if
# applicable every 3 * SCHEDULER_INTERVAL_SECONDS
assertiveInterval = 3
```

## Setting up the docker/podman environment

> `docker` and `podman` commands are interchangeable and are built around the same OCI specifications. The examples
> below will be using `podman` because it's just as awesome, if not better in some significant ways.

### Setup secrets

After authenticating your personal Slack application by adding it to your Workspace, you will need to create the
secrets required to provide the context needed to establish connections to Slack's api.

Create a file `keys/token.key` and add the *User OAuth Token* generated by Slack on the Application page (see previous)

We will then need to create the secret:

```bash
podman secret create slack_status_scheduler_user_token ./keys/token.key
```

And then remove the secret file since we won't need the file anymore:

```bash
rm keys
````

### Configure and create the container

```bash
podman create \
  --name="slack-status-scheduler" \
  -v ./core:/core:ro \
  -v ./schedule.toml:/schedule.toml:ro \
  -e "TZ=$(cat /etc/timezone)" \
  --secret slack_status_scheduler_user_token \
  docker.io/denoland/deno:alpine-1.24.0 run \
  --allow-env=SCHEDULER_INTERVAL_SECONDS,SCHEDULER_MAX_DAYSPAN,SLACK_USER_TOKEN_KEYID,LOCALE \
  --allow-net=slack.com \
  --allow-read=/run/secrets,/schedule.toml \
  /core/runtime.ts
```

### Configuration options

- `SCHEDULER_INTERVAL=[2,3,4,5,6,10,15,30,60]` - The interval to schedule the check/set task in seconds.
   **Recommended values are `10`, `15`, `20`, or `30` - a value greater than 60 is not possible using this computational model**
   > This is done using Date-based offsetting, providing accuracy (elimination of drift), 
but a lack of precision (relying on Date constructor as well as the V8 event loop).

- `SCHEDULER_MAX_DAYSPAN` - The number of prior days to also compute - allowing for scheduled status that have a larger than 24 hour `duration`
  (The default is `2`)

- `TZ` - The system timezone needed by Deno to function correctly when computing schedules. **Not providing this will mean your
  configured schedules will be in UTC and not a reflection of local time!**

- `LOCALE` - The locale to parse weekdays (default is `en-US`).

- `SLACK_USER_TOKEN_KEYID` - The custom secret key to load the token from. This is useful for when running multiple containers on the same host


## Boot

```bash
podman start slack-status-scheduler
```