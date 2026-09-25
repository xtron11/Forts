import type { Dictionary } from './index';

export const en: Dictionary = {
  'bot.menuButton': 'Play',
  'bot.play': '🎮 Play',
  'bot.open': '🏰 Open fortress',
  'bot.start': '🏰 Hi, {name}! This is Forts: build a fortress, mine gold and farm food, train an army and raid your neighbours.\n\nTap "Play" 👇',
  'bot.start.noApp': '🏰 Hi, {name}! This is Forts. The mini app is not configured yet (WEBAPP_URL).',
  'bot.help':
    '🏰 Forts is a strategy game for a couple of minutes a day.\n\n⛏ Mines produce gold and 🌾 farms produce food even while you are away.\n🔨 Build and upgrade — builders work on their own.\n🔔 The bot reminds you when construction is done or storages are full.\n\n/start — open the game\n/settings — notifications\n/help — this help',
  'bot.settings': '🔔 Notifications. Tap to turn on or off:',
  'bot.settings.on': 'Turned on',
  'bot.settings.off': 'Turned off',
  'cmd.start': 'Start the game',
  'cmd.settings': 'Notifications',
  'cmd.help': 'About the game',
  'bot.description':
    '🏰 Forts is a strategy game in Telegram. Build a fortress, mine gold and farm food, train troops and raid other fortresses. Sessions take a couple of minutes, resources pile up while you are away.',
  'bot.shortDescription': '🏰 Build a fortress, gather resources, raid your neighbours.',

  'notifType.build_done': 'Construction complete',
  'notifType.storage_full': 'Mines and farms are full',

  'building.townhall': 'Town Hall',
  'building.goldmine': 'Gold Mine',
  'building.farm': 'Farm',
  'building.barracks': 'Barracks',
  'building.tower': 'Tower',
  'building.wall': 'Wall',

  'notif.built': ['🔨 {building} is built! Time to build more.', '✅ Builders are done: {building} is ready.', '🏗 Your new {building} is already at work!'],
  'notif.upgraded': ['🔨 {building} upgraded to lv. {level}!', '✅ Builders are done: {building} is now lv. {level}.', '🏗 {building} lv. {level} is ready — your fortress grows!'],
  'notif.full.gold': ['⛏ Your mines are full of gold — collect it before mining stops!', '💰 No more room for gold in your mines. Time to collect!', '⛏ Mines are full. Come grab your gold!'],
  'notif.full.food': ['🌾 Your farms are full — collect the harvest!', '🍞 No more room for food on your farms. Time to collect!', '🌾 Farms are full. The harvest is waiting!'],
  'notif.digest': ['🏰 Fortress news:', '📜 While you were away:', '🏰 Everything is ready in your fortress:'],
  'notif.line.built': '🔨 {building} is built',
  'notif.line.upgraded': '🔨 {building} lv. {level} is ready',
  'notif.line.full.gold': '⛏ mines are full of gold',
  'notif.line.full.food': '🌾 farms are full of food',
};
