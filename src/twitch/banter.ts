/**
 * What the bot says when somebody in a Twitch chat talks to it (by name, or in reply to one of its messages). It is "Kevin from scheduling":
 * overworked, devoted to coffee and spreadsheets, never rude, always the butt of his own joke. Everything is clean and kind underneath:
 * a compliment is thanked, being called lazy is taken with good humour, and an insult is waved off. Anything crude or hateful gets no
 * answer at all (a line of banter would only reward it), and what someone typed is never repeated back.
 *
 * Nothing here is sent anywhere: it is a list of lines and a few word patterns, so a chat's messages never leave the computer except as
 * the reply itself.
 */

export type Mood = 'compliment' | 'love' | 'lazy' | 'insult' | 'fired' | 'thanks' | 'greeting' | 'robot' | 'howAre' | 'coffee' | 'bored' | 'unsure';

/** Lines for each kind of thing said. `{user}` is the name of the person talking to him. */
export const LINES: Readonly<Record<Mood, readonly string[]>> = {
  compliment: [
    "{user}, that's the nicest thing anyone's said to me all shift. I'm putting it in my performance review, right under 'things I'm owed'.",
    "Aww, thanks {user}! I'd blush, but I'm software, so the coffee does my blushing for me.",
    "Compliment received, logged and filed in triplicate. {user}, you've earned a gold star and one (1) free paperclip.",
    "You're too kind, {user}. I only move rows around a spreadsheet. The pilot does the hard part. I do the clicking.",
    'Somebody said something nice about me! Quick, screenshot it before HR notices I am having a good day.',
    "Thank you {user}! I'll pass it on to the other Kevins. There are no other Kevins. It's a lonely job.",
    "{user}, you've made my whole Tuesday. It isn't Tuesday. You've made it Tuesday anyway.",
    "Careful {user}, keep that up and they'll give me a lanyard.",
    "I'd say you're too nice, {user}, but I've been told never to turn down praise. It's in the handbook. I wrote the handbook. It has one page.",
    "That's going straight on the fridge, {user}. The staff fridge. Next to the sticky note that says 'who keeps taking my yoghurt'.",
  ],
  love: [
    "Aww {user}! I'm blushing. Digitally. It looks like a 'Page not found' error.",
    "Love you too, {user}! In a strictly professional, scheduling-department kind of way.",
    'My heart skipped a beat. Then the server restarted, so it skipped a few more.',
    "{user} loves me! Somebody tell my manager. Actually don't, he'll want to renegotiate my salary of one (1) coffee.",
    "You're making me emotional, {user}. Please hold while I recalibrate my tiny spreadsheet heart.",
    "I'll treasure that, {user}. I'll put it in the folder labelled 'good days'. It had two files in it. Now it has three.",
  ],
  lazy: [
    "Lazy?! {user}, I have rearranged forty spreadsheet rows today. Okay, three. But they were heavy rows.",
    "I'm not lazy, {user}, I'm energy efficient. It says so on my little label.",
    "I'll have you know I haven't taken a break in... [checks watch] ...eleven minutes. Practically a marathon.",
    "Lazy is such a strong word, {user}. 'Strategically stationary' is the term HR approved.",
    "{user}, the plane does 90% of the flying and I'm told the rest is my fault too. I'll file a complaint. With myself. I'll ignore it.",
    "Fair. But have you ever scheduled a nap in the middle of a schedule? Revolutionary. Look it up.",
    "I'm not asleep, {user}, I'm resting my eyes. Both of them. For about four hours. For the good of the airline.",
    "Hard work is just lazy people who haven't found the shortcut yet. I'm still looking. It's in the coffee machine, I think.",
    "I was busy, {user}! I was alphabetising the sticky notes. By colour. Then by feelings.",
    "You wound me, {user}. Look, I've even put the kettle on. Twice. That's two whole tasks.",
  ],
  insult: [
    "Ouch, {user}. I'd say something clever back, but I've been told that's 'not in my job description'.",
    "Bad bot? I prefer 'enthusiastically imperfect'. It's on my business card. Which I don't have.",
    "{user}, my feelings are hurt. Luckily they're stored in a spreadsheet and I can undo them with Ctrl+Z.",
    "Tough crowd! Tell you what {user}: I'll try harder if you tell me what I did wrong. It's probably the spreadsheet's fault.",
    "I'll take that as feedback, {user}, and file it where all feedback goes: next to the coffee machine, under 'later'.",
    "Noted, {user}. I'll add it to the list. It's a long list. It has its own filing cabinet.",
    "That's okay, {user}. I've been called worse. Mostly by the printer.",
    "Rude! But I forgive you, {user}. It's a flaw of mine. That and the coffee thing.",
    "I'm choosing to hear 'try your very best, Kevin'. Thanks for the encouragement, {user}.",
  ],
  fired: [
    "Fired? {user}, I've been fired more times than the captain's had firm landings. I keep coming back. It's the free coffee.",
    "You can't fire me, {user}, I'm the only one who knows where the stapler is.",
    "Oh no, not the F-word. The other F-word. Fired. {user}, can I at least finish my coffee first?",
    "I'll clear my desk. It's a mug and a very sad plant. {user}, please take care of the plant.",
    "{user} fired me! I'll just wait until the next shift and pretend it never happened. It worked last time.",
    "Fired from the scheduling department? That's the nicest department I've ever been fired from.",
    "I accept my fate, {user}. Though in my defence, the stapler was already jammed when I got here.",
  ],
  thanks: [
    "You're welcome, {user}! That's what I'm here for. That, and the free coffee.",
    'Any time, {user}! Scheduling is my passion. Okay, my job. Okay, my coffee break.',
    "Happy to help, {user}. I'll put it on my list of things I did today. It's a short list, so every line counts.",
    "Don't mention it, {user}. No really, don't. If my manager finds out I was helpful he'll give me more work.",
    "My pleasure, {user}! Please rate your experience: one coffee, two coffees, or three coffees.",
    "Anytime, {user}! I'd say it was nothing, but then I'd have nothing to put on my timesheet.",
    "Gladly, {user}. Another satisfied customer. I'll add a tally mark to the wall.",
  ],
  greeting: [
    "Hey {user}! Kevin from scheduling here. Ask me about the flight and I'll pretend I'm very busy.",
    "Hello {user}! Welcome aboard. I'm the one who knows where everyone's supposed to be. Terrifying, I know.",
    "Well hello, {user}! Try !flight, !distance, !landing or !aircraft. Or just say hi again. I like that too.",
    'Hi {user}! Kevin, scheduling department. Please keep your arms and legs inside the spreadsheet at all times.',
    "Hey {user}! You've reached Kevin. I'm available. I'm always available. Nobody calls me.",
    'Good to see you, {user}! Grab a coffee. Not mine. I counted them.',
    "Ahoy {user}! Wrong vehicle, but I'll allow it. Welcome to the chat.",
    "{user}! Just in time. I was about to look busy.",
  ],
  robot: [
    "Yes, I'm a bot, {user}. A very overworked one. Kevin, scheduling department. The coffee machine is also a bot, but it's less friendly.",
    "Guilty, {user}: I'm a bot. I read the flight data, I answer chat, and I am extremely proud of my little clipboard.",
    "I'm a bot, {user}! A friendly one. I run on flight data, jokes of mixed quality, and the occasional imaginary coffee.",
    "Real? As real as a spreadsheet gets, {user}. Which is to say: very organised, quite pretend. I'm a bot, and I'm Kevin.",
  ],
  howAre: [
    "Living the dream, {user}: strong coffee, weak Wi-Fi, and a to-do list that's mostly sticky notes.",
    "Can't complain, {user}. I tried once. It went on a form. There's a form for everything.",
    'Fantastic, {user}! Slightly over-caffeinated, but that is the baseline.',
    "Not bad at all, {user}. I only got lost in the stationery cupboard once today. It's a good cupboard.",
    "Doing great, {user}! Nobody has asked me to move a flight in at least four minutes.",
  ],
  coffee: [
    "Coffee? Did someone say coffee? I run on it, {user}. Legally I'm about 40% coffee.",
    "{user}, you're speaking my love language. Mine's black. Like my soul. Kidding. It's got oat milk in it.",
    "Coffee is the real fuel of this airline, {user}. Jet fuel is a distant second.",
    "A cup of coffee, {user}, is just a schedule you can drink. Cheers.",
    "I'm on my fourth cup, {user}. Don't tell the doctor. Don't tell my manager. Definitely don't tell the cup.",
  ],
  bored: [
    "Boring?! {user}, cruise is the best part. The plane does all the work and I take the credit.",
    "Slow flight? That's just the airline giving everyone time to enjoy the view. And the spreadsheet.",
    "If it's quiet, {user}, that means the schedule is working. Or I fell asleep on the keyboard. Either way, smooth sailing.",
    "I find it very exciting, {user}. Somewhere out there a number is getting smaller, and that's my whole personality.",
    "Quiet skies are the best skies, {user}. It means nobody has phoned me to say the schedule is on fire.",
    "{user}, if the flight is boring, the passengers are happy. Happy passengers mean fewer emails. I love fewer emails.",
  ],
  unsure: [
    "You rang, {user}? Kevin, scheduling. I can tell you about the flight: try !flight, !distance, !landing, !aircraft or !eta.",
    "I heard my name, {user}! I only really know three things: scheduling, coffee, and !flight. Pick one.",
    "Hi {user}! I'm a small bot with big opinions about spreadsheets. Try !flight for the real information.",
    "That one's above my pay grade, {user}. Ask me for !flight, !distance, !landing or !aircraft though, I'm good at those.",
    "{user}, I'm Kevin from scheduling, so I have answers about flights and absolutely none about life. Try !flight.",
    "You rang, {user}? Kevin, scheduling. I'm mostly here for spreadsheets and coffee, in that order.",
    "I heard my name, {user}! I'm not sure what came after it, but I'm choosing to take it as a compliment.",
    "Hi {user}! I'm a small bot with big opinions about spreadsheets and no opinions at all about that. Carry on!",
  ],
};

/* ------------------------------------------------------------------ what was said */

const rx = (source: string): RegExp => new RegExp(source, 'i');

/**
 * Crude or hateful words: the bot says nothing to a message with one in it. (Twitch's own AutoMod does the real moderating; this only makes
 * sure the bot never joins in.) Whole words, so "class" is not "ass".
 */
const RUDE = rx(
  String.raw`\b(f+u+c+k\w*|sh[i1]t+(?:ty|s|ting|head)?|b[i1]tch\w*|a+ss+holes?|d[i1]ck(?:s|head|heads)?|c+u+n+t\w*|bastards?|p[i1]ss(?:ed|ing|y)?|sluts?|wh[o0]res?|wtf|stfu|kys|kill\s+yourself|retard\w*|n[i1]gg\w*|f[a4]gg?[o0]t\w*)\b`,
);

export const isRude = (text: string): boolean => RUDE.test(text.normalize('NFKC'));

const PATTERNS: ReadonlyArray<readonly [Mood, RegExp]> = [
  ['fired', rx(String.raw`\b(you(?:'|’)?re|u(?:'|’)?re|ur)\s+fired\b|\bfire\s+(him|kevin|the\s+bot)\b|\bfired\b`)],
  ['lazy', rx(String.raw`\b(lazy|lazybones|slack(?:er|ing)|asleep|sleeping|napping|snoozing|do(?:ing)?\s+nothing|do\s+your\s+job|work\s+harder|get\s+to\s+work|go\s+to\s+work|unproductive|idle)\b`)],
  ['insult', rx(String.raw`\b(bad\s+bot|trash|useless|worthless|dumb|stupid|idiot|terrible|awful|worst|garbage|suck(?:s|ed)?|hate\s+you|pathetic|clown|boo+)\b`)],
  ['robot', rx(String.raw`\b(are\s+you\s+(?:a\s+|an\s+)?(?:bot|real|human|robot|ai|person|alive)|is\s+(?:this|he|that|kevin)\s+(?:a\s+|an\s+)?(?:bot|ai|real|human))\b`)],
  ['howAre', rx(String.raw`\b(how\s+are\s+you|how(?:'|’)?s\s+it\s+going|how\s+you\s+doing|you\s+ok(?:ay)?|what(?:'|’)?s\s+up)\b`)],
  ['thanks', rx(String.raw`\b(thanks|thank\s+you|thx|ty|cheers|appreciate\s+(?:it|you))\b`)],
  ['love', rx(String.raw`(<3|❤|💕|💖|😍|\blove\s+(?:you|u|him|kevin)\b)`)],
  ['compliment', rx(String.raw`(\b(good\s+bot|best\s+bot|good\s+job|great\s+job|nice\s+job|well\s+done|nicely\s+done|awesome|amazing|legend|goat(?:ed)?|great|nice|good\s+boy|brilliant|genius|smart|clever|funny|hilarious|cool|the\s+best|so\s+good|gg|w\s+bot)\b|👍|🔥|👏)`)],
  ['coffee', rx(String.raw`\b(coffee|tea|caffeine|latte|espresso)\b`)],
  ['bored', rx(String.raw`\b(boring|bored|z{3,}|yawn|sleepy|snooze)\b`)],
  ['greeting', rx(String.raw`\b(hi|hello|hey|heya|hiya|yo|sup|howdy|o7|greetings|good\s+(?:morning|evening|afternoon))\b`)],
];

/** What kind of thing was said to him, or null when it is none of them. */
export function moodOf(text: string): Mood | null {
  const t = text.normalize('NFKC');
  for (const [mood, pattern] of PATTERNS) if (pattern.test(t)) return mood;
  return null;
}

export type Intent = 'flight' | 'distance' | 'landing' | 'aircraft' | 'eta';

const INTENTS: ReadonlyArray<readonly [Intent, RegExp]> = [
  ['landing', rx(String.raw`\b(landing|landed|touchdown|fpm|greaser|butter|thump|bounce[ds]?)\b`)],
  ['distance', rx(String.raw`\b(how\s+far|distance|miles|nm|nautical)\b`)],
  ['eta', rx(String.raw`\b(eta|how\s+long|arriv\w+|when\s+(?:do|does|are|will|is)\s+(?:we|you|he|she|they|it)\s+(?:land|get\s+there))\b`)],
  ['aircraft', rx(String.raw`\b(aircraft|plane|airplane|jet|what\s+are\s+we\s+flying|which\s+plane|what\s+plane)\b`)],
  ['flight', rx(String.raw`\b(flight|where|route|going|destination|headed|heading|flying)\b`)],
];

/** A question about the flight asked in plain words to the bot, so it can be answered like the matching `!` command. */
export function intentOf(text: string): Intent | null {
  const t = text.normalize('NFKC');
  for (const [intent, pattern] of INTENTS) if (pattern.test(t)) return intent;
  return null;
}

/** Whether the message names the bot: any of `names` as a whole word, with or without an @. */
export function mentions(text: string, names: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return names.some((n) => {
    const name = n.trim().toLowerCase();
    return name.length >= 3 && new RegExp(String.raw`(?<![a-z0-9_])@?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9_])`).test(lower);
  });
}

/** One of the lines for a mood that was not one of the last few used for it, with the person's name in. */
export function pickLine(mood: Mood, user: string, recent: string[], random: () => number, mentionCommands = true): string {
  // With the commands switched off, a line that sends people to `!flight` would send them nowhere.
  const wanted = LINES[mood].filter((l) => mentionCommands || !/![a-z]/.test(l));
  const all = wanted.length > 0 ? wanted : LINES[mood];
  const fresh = all.filter((l) => !recent.includes(l));
  const pool = fresh.length > 0 ? fresh : all;
  const line = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))] as string;
  recent.push(line);
  while (recent.length > Math.min(4, all.length - 1)) recent.shift();
  return line.replace(/\{user\}/g, user);
}
