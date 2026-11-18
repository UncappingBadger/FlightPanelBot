/**
 * The Client ID of this app's registered Twitch application (https://dev.twitch.tv/console, type "Public"). A Client ID names the application
 * to Twitch and is not a secret: the device sign-in needs nothing else, so it can sit in the source and in every copy of the app.
 *
 * A host who would rather use a Twitch application of their own (a minute, free) can put its Client ID on the setup page, which takes the
 * place of this one.
 */
export const BUILT_IN_TWITCH_CLIENT_ID = '7b5xxn34wuzpdr0x5xukq58quh5r1e';

/** A Client ID is 30 letters and digits. */
export const validClientId = (id: string): boolean => /^[a-z0-9]{20,40}$/i.test(id.trim());
