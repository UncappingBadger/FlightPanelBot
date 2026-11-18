/**
 * The Client ID of this app's registered Twitch application (https://dev.twitch.tv/console, type "Public"). A Client ID names the application
 * to Twitch and is not a secret: the device sign-in needs nothing else, so it can sit in the source and in every copy of the app.
 *
 * Empty until the project's own Twitch application is registered; until then a host who wants Twitch chat can register one of their own
 * (a minute, free) and put its Client ID on the setup page, which takes the place of this one.
 */
export const BUILT_IN_TWITCH_CLIENT_ID = '';

/** A Client ID is 30 letters and digits. */
export const validClientId = (id: string): boolean => /^[a-z0-9]{20,40}$/i.test(id.trim());
