// @ts-check

/**
 * A small curated emoji set for page icons, grouped, each with search
 * words. Not the whole Unicode list: a full picker (and uploaded images)
 * can come later.
 */

/** @typedef {{ emoji: string, name: string, search: string }} Emoji */
/** @typedef {{ label: string, items: Emoji[] }} EmojiGroup */

/**
 * "emoji name, more search words" per line.
 * @param {string} lines
 * @returns {Emoji[]}
 */
function parse(lines) {
  return lines
    .trim()
    .split("\n")
    .map((line) => {
      const [emoji, ...words] = line.trim().split(" ");
      const text = words.join(" ");
      return { emoji, name: text.split(",")[0].trim(), search: text.toLowerCase() };
    });
}

/** @type {EmojiGroup[]} */
export const EMOJI_GROUPS = [
  {
    label: "Smileys & people",
    items: parse(`
      😀 grinning face, happy smile
      😄 smiling face, happy joy
      😅 sweat smile, relief
      😂 tears of joy, laugh
      🙂 slightly smiling face
      😉 winking face
      😍 heart eyes, love
      🤩 star struck, excited
      🤔 thinking face, idea question
      😎 sunglasses, cool
      🥳 party face, celebrate
      😴 sleeping face, tired
      🤯 mind blown, exploding head
      👋 waving hand, hello welcome
      👍 thumbs up, yes approve
      👏 clapping hands, applause
      🙌 raising hands, celebrate
      🙏 folded hands, thanks please
      💪 flexed biceps, strong
      🧠 brain, think smart
      👀 eyes, look watch
      🧑‍💻 technologist, developer laptop
    `),
  },
  {
    label: "Nature",
    items: parse(`
      🌱 seedling, plant grow sprout
      🌿 herb, leaf plant
      🍀 four leaf clover, luck
      🌳 tree, deciduous nature
      🌵 cactus, desert
      🌸 cherry blossom, flower spring
      🌻 sunflower, flower summer
      🍁 maple leaf, autumn fall
      ☀️ sun, sunny weather
      🌙 crescent moon, night
      ⭐ star
      🌈 rainbow
      🔥 fire, hot flame
      💧 droplet, water
      ❄️ snowflake, winter cold
      🌊 water wave, ocean sea
      🐶 dog face, puppy pet
      🐱 cat face, kitten pet
      🦊 fox
      🐻 bear
      🐼 panda
      🦉 owl, wise night
      🐝 honeybee, bee busy
      🦋 butterfly
    `),
  },
  {
    label: "Food & drink",
    items: parse(`
      ☕ coffee, hot beverage tea
      🍵 tea, matcha
      🍎 red apple, fruit
      🍋 lemon, citrus
      🍓 strawberry, fruit
      🥑 avocado
      🍕 pizza
      🍔 hamburger, burger
      🍜 noodles, ramen bowl
      🍰 cake, shortcake dessert
      🍪 cookie
      🍷 wine glass
    `),
  },
  {
    label: "Activities & travel",
    items: parse(`
      ⚽ soccer ball, football sport
      🏀 basketball, sport
      🎯 direct hit, target goal
      🎮 video game, controller play
      🎲 game die, dice
      🎨 palette, art paint design
      🎬 clapper board, film movie
      🎧 headphone, music listen
      🎸 guitar, music
      ✈️ airplane, travel flight
      🚀 rocket, launch ship
      🚲 bicycle, bike
      🏠 house, home
      🏢 office building, work company
      🗺️ world map, travel
      🏝️ desert island, vacation
      ⛰️ mountain, hike
      🏁 chequered flag, finish
    `),
  },
  {
    label: "Objects",
    items: parse(`
      📄 page facing up, document
      📝 memo, note write
      📚 books, library read
      📖 open book, read
      📓 notebook, journal
      📕 closed book, red
      📗 green book
      📘 blue book
      📌 pushpin, pin
      📎 paperclip, attachment
      ✏️ pencil, write edit
      🖊️ pen, write
      📅 calendar, date
      🗓️ spiral calendar, schedule plan
      📊 bar chart, stats
      📈 chart increasing, growth trend
      💡 light bulb, idea
      🔑 key, password
      🔒 locked, private secure
      🛠️ hammer and wrench, tools build
      ⚙️ gear, settings
      💻 laptop, computer
      📱 mobile phone
      📷 camera, photo
      🎁 wrapped gift, present
      💰 money bag, budget finance
      💼 briefcase, work business
      📦 package, box ship
      🧪 test tube, experiment lab
      🔬 microscope, research science
      ⌨️ keyboard, type
      ✉️ envelope, mail email invite
      📲 mobile arrow, install app
      🔗 link, chain url
    `),
  },
  {
    label: "Symbols",
    items: parse(`
      ✅ check mark button, done
      ☑️ check box, task
      ❌ cross mark, no
      ❗ exclamation mark, important
      ❓ question mark
      ⚠️ warning, caution
      💬 speech balloon, chat comment
      💭 thought balloon, idea
      ❤️ red heart, love
      🧡 orange heart
      💛 yellow heart
      💚 green heart
      💙 blue heart
      💜 purple heart
      🖤 black heart
      ✨ sparkles, new magic
      🚩 triangular flag, kickoff milestone
      🎉 party popper, celebrate tada
      🔖 bookmark
      🏷️ label, tag
      ♻️ recycling
      🔔 bell, notification
      🎵 musical note
      ➕ plus, add
    `),
  },
];

/** Every emoji, flattened. */
export const ALL_EMOJI = EMOJI_GROUPS.flatMap((group) => group.items);

/**
 * Emoji whose name or search words contain every word of `query`, in order of the groups.
 * @param {string} query
 * @returns {Emoji[]}
 */
export function searchEmoji(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return ALL_EMOJI;
  return ALL_EMOJI.filter((item) => words.every((word) => item.search.includes(word)));
}
