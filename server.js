'use strict';
const express   = require('express');
const http      = require('http');
const { WebSocketServer } = require('ws');
const { Pool }  = require('pg');
const crypto    = require('crypto');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });
// Zeabur auto-injects POSTGRES_* when PostgreSQL is in the same project.
// Fall back gracefully if no DB is configured.
const pgUri = process.env.DATABASE_URL
  || process.env.POSTGRES_URI
  || (process.env.POSTGRES_HOST
      ? `postgresql://${process.env.POSTGRES_USERNAME||'postgres'}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT||5432}/${process.env.POSTGRES_DB||'postgres'}`
      : null);

const pool = pgUri
  ? new Pool({ connectionString: pgUri, ssl: { rejectUnauthorized: false } })
  : null;

app.use(express.static('public'));
app.use(express.json());

/* ═══════════════════════════════════════════
   GAME DATA  (mirrors pokemon_battle.html)
═══════════════════════════════════════════ */
const POKEMON = [
  // Tier 1
  { id:3,   name:'妙蛙花',     type:'grass',    type2:'poison',  hp:250, tier:1, attacks:[{name:'太陽射線',dmg:40,type:'grass',   status:{effect:'sleep',    chance:0.20}},{name:'大地之力',dmg:55,type:'ground',  status:{effect:'poison',   chance:0.30}},{name:'毒粉刺',  dmg:42,type:'poison',  status:{effect:'poison',   chance:0.35}},{name:'葉刃',    dmg:52,type:'grass'}]},
  { id:94,  name:'耿鬼',       type:'ghost',    type2:'poison',  hp:220, tier:1, attacks:[{name:'幽靈之爪',dmg:40,type:'ghost',   status:{effect:'poison',   chance:0.20}},{name:'咬碎',    dmg:52,type:'dark'},                                                {name:'暗影球',  dmg:50,type:'ghost'},                                                {name:'催眠術',  dmg:28,type:'psychic', status:{effect:'sleep',    chance:0.50}}]},
  { id:68,  name:'怪力',       type:'fighting', hp:260, tier:1, attacks:[{name:'動感拳',  dmg:42,type:'fighting'},{name:'地震',    dmg:58,type:'ground'},{name:'岩石滑落',dmg:48,type:'rock',    status:{effect:'paralysis',chance:0.15}},{name:'超強衝擊',dmg:60,type:'fighting'}]},
  { id:65,  name:'胡地',       type:'psychic',  hp:200, tier:1, attacks:[{name:'超能力',  dmg:40,type:'psychic', status:{effect:'confusion',chance:0.30}},{name:'閃電拳',dmg:52,type:'electric',status:{effect:'paralysis',chance:0.20}},{name:'念力',    dmg:45,type:'psychic', status:{effect:'confusion',chance:0.25}},{name:'暗影球',  dmg:48,type:'ghost'}]},
  { id:26,  name:'雷丘',       type:'electric', hp:200, tier:1, attacks:[{name:'十萬伏特',dmg:40,type:'electric',status:{effect:'paralysis',chance:0.30}},{name:'鐵尾',   dmg:52,type:'steel'},{name:'電磁衝浪',dmg:50,type:'electric',status:{effect:'paralysis',chance:0.20}},{name:'衝撞',    dmg:38,type:'normal'}]},
  { id:376, name:'巨金怪',     type:'steel',    type2:'psychic', hp:260, tier:1, attacks:[{name:'子彈拳',  dmg:42,type:'steel'},{name:'隕石衝擊',dmg:58,type:'rock'},{name:'精神強擊',dmg:50,type:'psychic', status:{effect:'confusion',chance:0.20}},{name:'閃光炮',  dmg:52,type:'steel'}]},
  { id:448, name:'路卡利歐',   type:'fighting', type2:'steel',   hp:220, tier:1, attacks:[{name:'波導彈',  dmg:40,type:'fighting'},{name:'金屬爪',  dmg:48,type:'steel'},{name:'暗影球',  dmg:52,type:'ghost'},{name:'龍之脈動',dmg:50,type:'dragon'}]},
  { id:130, name:'暴鯉龍',     type:'water',    type2:'flying',  hp:260, tier:1, attacks:[{name:'大浪',    dmg:42,type:'water'},{name:'咬碎',    dmg:58,type:'dark'},{name:'龍息',    dmg:45,type:'dragon'},{name:'怒風',    dmg:52,type:'flying'}]},
  { id:35,  name:'皮皮',       type:'fairy',    hp:220, tier:1, attacks:[{name:'月亮力量',dmg:40,type:'fairy',   status:{effect:'confusion',chance:0.25}},{name:'元氣拳',  dmg:52,type:'normal'},{name:'火焰拳',  dmg:42,type:'fire'},{name:'冰凍拳',  dmg:42,type:'ice'}]},
  { id:87,  name:'白海獅',     type:'water',    type2:'ice',     hp:240, tier:1, attacks:[{name:'冷凍光線',dmg:40,type:'ice',     status:{effect:'freeze',   chance:0.15}},{name:'衝浪',    dmg:52,type:'water'},{name:'閃電拳',  dmg:42,type:'electric',status:{effect:'paralysis',chance:0.15}},{name:'大浪',    dmg:48,type:'water'}]},
  { id:82,  name:'三合磁怪',   type:'electric', type2:'steel',   hp:210, tier:1, attacks:[{name:'電磁炮',  dmg:40,type:'electric',status:{effect:'paralysis',chance:0.30}},{name:'閃光炮',  dmg:52,type:'steel'},{name:'電磁衝浪',dmg:48,type:'electric',status:{effect:'paralysis',chance:0.20}},{name:'鋼鐵身壓',dmg:45,type:'steel'}]},
  { id:28,  name:'沙包蛇',     type:'ground',   hp:240, tier:1, attacks:[{name:'地震',    dmg:40,type:'ground'},{name:'岩石滑落',dmg:52,type:'rock'},{name:'岩石碎裂',dmg:48,type:'rock'},{name:'十字切',  dmg:38,type:'normal'}]},
  { id:80,  name:'呆殼獸',     type:'water',    type2:'psychic', hp:260, tier:1, attacks:[{name:'衝浪',    dmg:40,type:'water'},{name:'念力',    dmg:52,type:'psychic', status:{effect:'confusion',chance:0.20}},{name:'大浪',    dmg:50,type:'water'},{name:'精神強擊',dmg:48,type:'psychic', status:{effect:'confusion',chance:0.20}}]},
  { id:884, name:'鋼鍇鴉',     type:'steel',    type2:'flying',  hp:250, tier:1, attacks:[{name:'鐵翼',    dmg:42,type:'steel'},{name:'颶風飛翔',dmg:52,type:'flying'},{name:'鋼鐵身壓',dmg:45,type:'steel'},{name:'夜斬',    dmg:48,type:'dark'}]},
  { id:160, name:'大力鱷',     type:'water',    hp:260, tier:1, attacks:[{name:'咬碎',    dmg:42,type:'dark'},{name:'衝浪',    dmg:52,type:'water'},{name:'冰凍拳',  dmg:48,type:'ice',     status:{effect:'freeze',   chance:0.10}},{name:'水砲',    dmg:58,type:'water'}]},
  { id:658, name:'忍蛙',       type:'water',    type2:'dark',    hp:220, tier:1, attacks:[{name:'水手裏劍',dmg:38,type:'water'},{name:'夜斬',    dmg:40,type:'dark'},{name:'暗影球',  dmg:50,type:'ghost'},{name:'大浪',    dmg:52,type:'water'}]},
  // Tier 2
  { id:6,   name:'噴火龍',     type:'fire',     type2:'flying',  hp:290, tier:2, attacks:[{name:'火焰噴射',dmg:45,type:'fire',    status:{effect:'burn',     chance:0.25}},{name:'破空飛翔',dmg:70,type:'flying'},{name:'龍息',    dmg:50,type:'dragon'},{name:'火焰衝擊',dmg:60,type:'fire',    status:{effect:'burn',     chance:0.20}}]},
  { id:9,   name:'水箭龜',     type:'water',    hp:280, tier:2, attacks:[{name:'水砲',    dmg:45,type:'water'},{name:'冰凍光束',dmg:65,type:'ice',     status:{effect:'freeze',   chance:0.15}},{name:'閃光炮',  dmg:52,type:'steel'},{name:'衝浪',    dmg:55,type:'water'}]},
  { id:150, name:'超夢',       type:'psychic',  hp:320, tier:2, attacks:[{name:'念力衝擊',dmg:45,type:'psychic', status:{effect:'confusion',chance:0.30}},{name:'暗影球',  dmg:75,type:'ghost'},{name:'閃電拳',  dmg:55,type:'electric',status:{effect:'paralysis',chance:0.20}},{name:'氣功拳',  dmg:50,type:'fighting'}]},
  { id:149, name:'快龍',       type:'dragon',   type2:'flying',  hp:320, tier:2, attacks:[{name:'龍息',    dmg:45,type:'dragon'},{name:'破壞光線',dmg:75,type:'normal'},{name:'雷電',    dmg:60,type:'electric',status:{effect:'paralysis',chance:0.25}},{name:'怒風',    dmg:60,type:'flying'}]},
  { id:143, name:'卡比獸',     type:'normal',   hp:380, tier:2, attacks:[{name:'磚塊',    dmg:45,type:'rock'},{name:'破壞光線',dmg:68,type:'normal'},{name:'地震',    dmg:60,type:'ground'},{name:'連踢',    dmg:50,type:'normal'}]},
  { id:59,  name:'風速狗',     type:'fire',     hp:260, tier:2, attacks:[{name:'夜斬',    dmg:45,type:'dark'},{name:'噴射火焰',dmg:65,type:'fire',    status:{effect:'burn',     chance:0.25}},{name:'閃電犬牙',dmg:50,type:'electric',status:{effect:'paralysis',chance:0.15}},{name:'衝撞',    dmg:52,type:'normal'}]},
  { id:131, name:'拉普拉斯',   type:'water',    type2:'ice',     hp:290, tier:2, attacks:[{name:'衝浪',    dmg:45,type:'water'},{name:'暴風雪',  dmg:65,type:'ice',     status:{effect:'freeze',   chance:0.20}},{name:'雷電',    dmg:55,type:'electric',status:{effect:'paralysis',chance:0.20}},{name:'冷凍光線',dmg:50,type:'ice',     status:{effect:'freeze',   chance:0.15}}]},
  { id:445, name:'烈咬陸鯊',   type:'dragon',   type2:'ground',  hp:280, tier:2, attacks:[{name:'龍爪',    dmg:45,type:'dragon'},{name:'地震',    dmg:68,type:'ground'},{name:'龍之隕星',dmg:70,type:'dragon'},{name:'岩石滑落',dmg:52,type:'rock'}]},
  { id:210, name:'布比獸',     type:'fairy',    hp:300, tier:2, attacks:[{name:'仙女之力',dmg:45,type:'fairy'},{name:'地震',    dmg:68,type:'ground'},{name:'咬碎',    dmg:55,type:'dark'},{name:'雷電',    dmg:50,type:'electric',status:{effect:'paralysis',chance:0.15}}]},
  { id:700, name:'仙子伊布',   type:'fairy',    hp:300, tier:2, attacks:[{name:'妖精風',  dmg:45,type:'fairy'},{name:'暗影球',  dmg:68,type:'ghost'},{name:'冰凍光束',dmg:55,type:'ice',     status:{effect:'freeze',   chance:0.15}},{name:'月亮力量',dmg:60,type:'fairy'}]},
  { id:478, name:'雪妖女',     type:'ice',      type2:'ghost',   hp:280, tier:2, attacks:[{name:'冰凍光束',dmg:45,type:'ice',     status:{effect:'freeze',   chance:0.15}},{name:'暗影球',  dmg:68,type:'ghost'},{name:'怒風',    dmg:55,type:'flying'},{name:'冰耳光',  dmg:60,type:'ice',     status:{effect:'freeze',   chance:0.15}}]},
  { id:614, name:'冰熊王',     type:'ice',      hp:320, tier:2, attacks:[{name:'冰耳光',  dmg:45,type:'ice',     status:{effect:'freeze',   chance:0.15}},{name:'地震',    dmg:68,type:'ground'},{name:'大浪',    dmg:55,type:'water'},{name:'暴風雪',  dmg:65,type:'ice',     status:{effect:'freeze',   chance:0.15}}]},
  { id:430, name:'夜巡使',     type:'dark',     type2:'flying',  hp:300, tier:2, attacks:[{name:'夜斬',    dmg:45,type:'dark'},{name:'怒風',    dmg:68,type:'flying'},{name:'夜騷動',  dmg:55,type:'dark'},{name:'空氣斬',  dmg:60,type:'flying'}]},
  { id:466, name:'電擊魔獸',   type:'electric', hp:300, tier:2, attacks:[{name:'電磁衝浪',dmg:45,type:'electric',status:{effect:'paralysis',chance:0.25}},{name:'冰凍拳',  dmg:68,type:'ice',     status:{effect:'freeze',   chance:0.15}},{name:'動感拳',  dmg:55,type:'fighting'},{name:'十萬伏特',dmg:60,type:'electric',status:{effect:'paralysis',chance:0.20}}]},
  { id:467, name:'鴨嘴火獸',   type:'fire',     hp:300, tier:2, attacks:[{name:'火焰衝擊',dmg:45,type:'fire',    status:{effect:'burn',     chance:0.25}},{name:'雷電',    dmg:68,type:'electric',status:{effect:'paralysis',chance:0.20}},{name:'噴射火焰',dmg:60,type:'fire',    status:{effect:'burn',     chance:0.20}},{name:'地震',    dmg:55,type:'ground'}]},
  { id:157, name:'火爆獸',     type:'fire',                      hp:260, tier:2, attacks:[{name:'爆炸火焰',dmg:68,type:'fire'},{name:'噴火',    dmg:55,type:'fire',    status:{effect:'burn',     chance:0.25}},{name:'烈火強衝',dmg:72,type:'fire'},{name:'地震',    dmg:58,type:'ground'}]},
  { id:763, name:'大竹葵',     type:'grass',                     hp:270, tier:2, attacks:[{name:'蔓藤鞭',  dmg:62,type:'grass'},{name:'葉刃',    dmg:55,type:'grass'},{name:'高跳踢',  dmg:65,type:'fighting'},{name:'踢踏舞',  dmg:60,type:'grass'}]},
  // Tier 3
  { id:383, name:'固拉多',     type:'ground',   hp:340, tier:3, attacks:[{name:'地震',    dmg:50,type:'ground'},{name:'原始大地',dmg:90,type:'fire',    status:{effect:'burn',     chance:0.30}},{name:'岩石碎裂',dmg:60,type:'rock'},{name:'火焰噴射',dmg:70,type:'fire',    status:{effect:'burn',     chance:0.25}}]},
  { id:382, name:'蓋歐卡',     type:'water',    hp:340, tier:3, attacks:[{name:'源起之波',dmg:50,type:'water'},{name:'原始海洋',dmg:90,type:'ice',     status:{effect:'freeze',   chance:0.20}},{name:'雷電',    dmg:70,type:'electric',status:{effect:'paralysis',chance:0.25}},{name:'大浪',    dmg:72,type:'water'}]},
  { id:384, name:'列空座',     type:'dragon',   type2:'flying',  hp:360, tier:3, attacks:[{name:'神速',    dmg:48,type:'normal'},{name:'龍之隕星',dmg:95,type:'dragon'},{name:'怒風',    dmg:80,type:'flying'},{name:'火焰噴射',dmg:70,type:'fire',    status:{effect:'burn',     chance:0.25}}]},
  { id:1008,name:'密勒頓',     type:'electric', type2:'dragon',  hp:360, tier:3, attacks:[{name:'電磁衝浪',dmg:52,type:'electric',status:{effect:'paralysis',chance:0.25}},{name:'未來雷霆',dmg:92,type:'psychic', status:{effect:'confusion',chance:0.25}},{name:'龍息',    dmg:70,type:'dragon'},{name:'電磁炮',  dmg:80,type:'electric',status:{effect:'paralysis',chance:0.20}}]},
  { id:250, name:'鳳王',       type:'fire',     type2:'flying',  hp:340, tier:3, attacks:[{name:'聖焰',    dmg:52,type:'fire',    status:{effect:'burn',     chance:0.30}},{name:'神聖之焰',dmg:92,type:'flying'},{name:'怒風',    dmg:70,type:'flying'},{name:'超能力',  dmg:72,type:'psychic', status:{effect:'confusion',chance:0.20}}]},
  { id:249, name:'路奇亞',     type:'psychic',  type2:'flying',  hp:340, tier:3, attacks:[{name:'怒風',    dmg:50,type:'flying'},{name:'心靈衝擊',dmg:90,type:'psychic', status:{effect:'confusion',chance:0.30}},{name:'暴風',    dmg:80,type:'flying'},{name:'冰凍光束',dmg:72,type:'ice',     status:{effect:'freeze',   chance:0.20}}]},
  { id:1007,name:'故勒頓',     type:'fighting', type2:'dragon',  hp:360, tier:3, attacks:[{name:'決勝衝擊',dmg:52,type:'fighting'},{name:'遠古之力',dmg:85,type:'rock'},{name:'火焰噴射',dmg:72,type:'fire',    status:{effect:'burn',     chance:0.25}},{name:'地震',    dmg:75,type:'ground'}]},
  { id:282, name:'沙奈朵',     type:'psychic',  type2:'fairy',   hp:320, tier:3, attacks:[{name:'妖精之力',dmg:50,type:'fairy'},{name:'精神強擊',dmg:90,type:'psychic', status:{effect:'confusion',chance:0.30}},{name:'月亮力量',dmg:75,type:'fairy'},{name:'暗影球',  dmg:72,type:'ghost'}]},
  { id:144, name:'急凍鳥',     type:'ice',      type2:'flying',  hp:340, tier:3, attacks:[{name:'暴風雪',  dmg:50,type:'ice',     status:{effect:'freeze',   chance:0.25}},{name:'怒風',    dmg:88,type:'flying'},{name:'冷凍光線',dmg:72,type:'ice',     status:{effect:'freeze',   chance:0.20}},{name:'暴風',    dmg:80,type:'flying'}]},
  { id:145, name:'閃電鳥',     type:'electric', type2:'flying',  hp:340, tier:3, attacks:[{name:'雷霆',    dmg:50,type:'electric',status:{effect:'paralysis',chance:0.30}},{name:'怒風',    dmg:88,type:'flying'},{name:'電磁衝浪',dmg:72,type:'electric',status:{effect:'paralysis',chance:0.25}},{name:'雷電',    dmg:80,type:'electric',status:{effect:'paralysis',chance:0.20}}]},
  { id:146, name:'火焰鳥',     type:'fire',     type2:'flying',  hp:340, tier:3, attacks:[{name:'火焰衝擊',dmg:50,type:'fire',    status:{effect:'burn',     chance:0.30}},{name:'怒風',    dmg:88,type:'flying'},{name:'噴射火焰',dmg:72,type:'fire',    status:{effect:'burn',     chance:0.25}},{name:'超能力',  dmg:70,type:'psychic', status:{effect:'confusion',chance:0.20}}]},
  { id:10188,name:'蒼響',      type:'fairy',    type2:'steel',   hp:370, tier:3, attacks:[{name:'剛劍',    dmg:85,type:'steel'},{name:'神秘劍',dmg:95,type:'fairy'},{name:'鐵頭功',dmg:75,type:'steel'},{name:'接近戰',dmg:90,type:'fighting'}]},
  { id:716, name:'哲爾尼亞斯', type:'fairy',    hp:370, tier:3, attacks:[{name:'月亮力量',dmg:52,type:'fairy'},{name:'精神強擊',dmg:92,type:'psychic', status:{effect:'confusion',chance:0.25}},{name:'光之波動',dmg:80,type:'fairy'},{name:'仙子之息',dmg:75,type:'fairy'}]},
  { id:378, name:'雷吉艾斯',   type:'ice',      hp:370, tier:3, attacks:[{name:'暴風雪',  dmg:50,type:'ice',     status:{effect:'freeze',   chance:0.20}},{name:'電磁砲',  dmg:88,type:'electric',status:{effect:'paralysis',chance:0.30}},{name:'閃光炮',  dmg:72,type:'steel'},{name:'冰耳光',  dmg:75,type:'ice',     status:{effect:'freeze',   chance:0.15}}]},
  { id:717, name:'伊菲爾塔爾', type:'dark',     type2:'flying',  hp:350, tier:3, attacks:[{name:'朽滅之歌',dmg:80,type:'flying'},{name:'惡之波動',dmg:50,type:'dark',   status:{effect:'confusion',chance:0.20}},{name:'空氣斬',  dmg:85,type:'flying'},{name:'夜騷動',  dmg:90,type:'dark'}]},
  { id:483, name:'帝牙盧卡',   type:'steel',    type2:'dragon',  hp:360, tier:3, attacks:[{name:'時間咆哮',dmg:95,type:'dragon'},{name:'閃光炮',  dmg:52,type:'steel'},{name:'龍爪',    dmg:82,type:'dragon'},{name:'鋼鐵翼',  dmg:75,type:'steel'}]},
  { id:484, name:'帕路奇亞',   type:'water',    type2:'dragon',  hp:360, tier:3, attacks:[{name:'空間扭曲',dmg:95,type:'dragon'},{name:'衝浪',    dmg:52,type:'water'},{name:'龍之脈動',dmg:82,type:'dragon'},{name:'水之脈動',dmg:85,type:'water',    status:{effect:'freeze',   chance:0.10}}]},
  { id:727, name:'赤焰咆哮虎', type:'fire',     type2:'dark',    hp:300, tier:2, attacks:[{name:'暗黑強打',dmg:62,type:'dark'},{name:'火焰噴射',dmg:55,type:'fire',    status:{effect:'burn',     chance:0.25}},{name:'超強衝擊',dmg:65,type:'fighting'},{name:'赤焰衝擊',dmg:70,type:'fire',    status:{effect:'burn',     chance:0.20}}]},
];
const EFF = {
  fire:     {grass:2, ice:2, steel:2, bug:2, water:0.5, fire:0.5, rock:0.5, dragon:0.5},
  water:    {fire:2, ground:2, rock:2, water:0.5, grass:0.5, dragon:0.5},
  grass:    {water:2, ground:2, rock:2, fire:0.5, grass:0.5, flying:0.5, poison:0.5, dragon:0.5, steel:0.5},
  electric: {water:2, flying:2, electric:0.5, grass:0.5, dragon:0.5, ground:0},
  psychic:  {fighting:2, poison:2, psychic:0.5, steel:0.5, dark:0},
  fighting: {normal:2, ice:2, rock:2, steel:2, dark:2, psychic:0.5, flying:0.5, poison:0.5, fairy:0.5, ghost:0},
  ghost:    {ghost:2, psychic:2, dark:0.5, normal:0},
  dragon:   {dragon:2, steel:0.5, fairy:0},
  steel:    {ice:2, rock:2, fairy:2, fire:0.5, water:0.5, electric:0.5, steel:0.5},
  ice:      {grass:2, ground:2, flying:2, dragon:2, fire:0.5, water:0.5, ice:0.5, steel:0.5},
  normal:   {rock:0.5, steel:0.5, ghost:0},
  dark:     {psychic:2, ghost:2, dark:0.5, fighting:0.5, fairy:0.5},
  flying:   {fighting:2, grass:2, bug:2, electric:0.5, rock:0.5, steel:0.5},
  ground:   {fire:2, electric:2, poison:2, rock:2, steel:2, grass:0.5, flying:0},
  rock:     {fire:2, ice:2, flying:2, bug:2, fighting:0.5, ground:0.5, steel:0.5},
  fairy:    {dragon:2, dark:2, fighting:2, fire:0.5, poison:0.5, steel:0.5},
  poison:   {grass:2, fairy:2, poison:0.5, ground:0.5, rock:0.5, ghost:0.5, steel:0},
};

const TRAINERS = [
  // ── items ──
  {id:'potion',     name:'傷藥',       cat:'item',      desc:'回復上場寶可夢 80 HP'},
  {id:'x-atk',      name:'攻擊強化',   cat:'item',      desc:'下次攻擊威力 +40'},
  {id:'x-def',      name:'防禦強化',   cat:'item',      desc:'下次受傷害減少 40'},
  {id:'energize',   name:'能量強化',   cat:'item',      desc:'下次攻擊傷害 ×2，但自身損失 50 HP'},
  {id:'antidote',   name:'萬能藥',     cat:'item',      desc:'解除上場寶可夢的異常狀態'},
  {id:'fire-bomb',  name:'火焰彈',     cat:'item',      desc:'讓對手上場寶可夢陷入燒傷'},
  {id:'gas-attack', name:'瓦斯攻擊',   cat:'item',      desc:'讓對手上場寶可夢陷入中毒'},
  {id:'switcher',   name:'交換器',     cat:'item',      desc:'讓對手上場寶可夢與備戰寶可夢隨機互換'},
  {id:'reflect',    name:'反彈鏡',     cat:'item',      desc:'下回合對手的攻擊傷害反彈回自身'},
  {id:'orb-fire',   name:'火焰寶珠',   cat:'item',      desc:'本回合攻擊改為火屬性'},
  {id:'orb-water',  name:'水流寶珠',   cat:'item',      desc:'本回合攻擊改為水屬性'},
  {id:'orb-elec',   name:'電氣寶珠',   cat:'item',      desc:'本回合攻擊改為電屬性'},
  {id:'orb-psychic',name:'超能寶珠',   cat:'item',      desc:'本回合攻擊改為超能屬性'},
  {id:'orb-ice',    name:'冰晶寶珠',   cat:'item',      desc:'本回合攻擊改為冰屬性'},
  {id:'orb-dragon', name:'龍紋寶珠',   cat:'item',      desc:'本回合攻擊改為龍屬性'},
  {id:'orb-dark',   name:'暗影寶珠',   cat:'item',      desc:'本回合攻擊改為惡屬性'},
  {id:'orb-fairy',  name:'妖精寶珠',   cat:'item',      desc:'本回合攻擊改為妖精屬性'},
  // ── supporters ──
  {id:'revive',     name:'復活藥',     cat:'supporter', desc:'復活備戰欄第一隻倒下的寶可夢（回復 80 HP）'},
  {id:'nurse',      name:'治療師',     cat:'supporter', desc:'上場寶可夢完全回復 HP 並解除異常狀態'},
  {id:'switch',     name:'換人命令',   cat:'supporter', desc:'免費換場，不消耗回合'},
  {id:'all-out',    name:'全力出擊',   cat:'supporter', desc:'下次攻擊傷害 ×3'},
  // ── stadium ──
  {id:'stadium-training', name:'訓練場',     cat:'stadium', desc:'場上所有技能威力 +20（雙方）'},
  {id:'stadium-spring',   name:'地熱溫泉',   cat:'stadium', desc:'每回合結束，雙方上場寶可夢各回復 15 HP'},
  {id:'stadium-reversal', name:'逆轉鬥技場', cat:'stadium', desc:'HP 低於 50% 時，攻擊威力 +30'},
];

const STATUS_ZH = {poison:'中毒',burn:'燒傷',paralysis:'麻痺',sleep:'睡眠',freeze:'結凍',confusion:'混亂'};

/* ═══════════════════════════════════════════
   GAME LOGIC  (synchronous server-side)
═══════════════════════════════════════════ */
function clonePoke(p) {
  return { ...p, attacks: p.attacks.map(a => ({...a})), cur: p.hp, status: null };
}

function srvEff(atkType, defType, defType2) {
  const m1 = (EFF[atkType] || {})[defType] ?? 1;
  const m2 = defType2 ? ((EFF[atkType] || {})[defType2] ?? 1) : 1;
  return m1 * m2;
}

function dealHand(n) {
  return [...TRAINERS].sort(() => Math.random() - 0.5).slice(0, n);
}

// Processes status before an attack. Mutates poke.
// Returns { skipped, died }
function handleStatus(poke, log) {
  const st = poke.status;
  if (!st) return { skipped: false, died: false };

  if (st.type === 'sleep') {
    st.turnsLeft--;
    if (st.turnsLeft > 0) {
      log.push({ text: `${poke.name} 睡著了，無法行動！`, cls: 'special' });
      return { skipped: true, died: false };
    }
    poke.status = null;
    log.push({ text: `${poke.name} 從睡眠中醒來了！`, cls: 'special' });
    return { skipped: false, died: false };
  }

  if (st.type === 'paralysis') {
    if (Math.random() < 0.25) {
      log.push({ text: `${poke.name} 因麻痺無法行動！`, cls: 'special' });
      return { skipped: true, died: false };
    }
    return { skipped: false, died: false };
  }

  if (st.type === 'freeze') {
    if (Math.random() < 0.20) {
      poke.status = null;
      log.push({ text: `${poke.name} 從結凍中解脫了！`, cls: 'special' });
      return { skipped: false, died: false };
    }
    log.push({ text: `${poke.name} 被凍住了，無法行動！`, cls: 'special' });
    return { skipped: true, died: false };
  }

  if (st.type === 'confusion') {
    st.turnsLeft--;
    if (st.turnsLeft <= 0) {
      poke.status = null;
      log.push({ text: `${poke.name} 從混亂中恢復了！`, cls: 'special' });
      return { skipped: false, died: false };
    }
    if (Math.random() < 0.5) {
      const dmg = 60;
      poke.cur = Math.max(0, poke.cur - dmg);
      log.push({ text: `${poke.name} 在混亂中攻擊了自己！（${dmg} 傷害）`, cls: 'special' });
      if (poke.cur <= 0) return { skipped: true, died: true };
      return { skipped: true, died: false };
    }
    return { skipped: false, died: false };
  }

  if (st.type === 'poison') {
    const dmg = Math.max(1, Math.floor(poke.hp / 8));
    poke.cur = Math.max(0, poke.cur - dmg);
    log.push({ text: `${poke.name} 因中毒損失了 ${dmg} HP！`, cls: 'special' });
    if (poke.cur <= 0) return { skipped: true, died: true };
    return { skipped: false, died: false };
  }

  if (st.type === 'burn') {
    const dmg = Math.max(1, Math.floor(poke.hp / 16));
    poke.cur = Math.max(0, poke.cur - dmg);
    log.push({ text: `${poke.name} 因燒傷損失了 ${dmg} HP！`, cls: 'special' });
    if (poke.cur <= 0) return { skipped: true, died: true };
    return { skipped: false, died: false };
  }

  return { skipped: false, died: false };
}

// Executes attack and mutates defender/buffs. Returns { damage, mult }.
function doAttack(attacker, defender, atk, aBuff, dBuff, log, G) {
  const atkType   = aBuff.typeOverride || atk.type;
  const burnMult  = attacker.status?.type === 'burn' ? 0.7 : 1;

  // Reflect mirror: bounce damage back to attacker
  if (dBuff.reflect) {
    dBuff.reflect = false;
    const rawMult = srvEff(atkType, attacker.type);
    const dmg     = Math.max(1, Math.floor((atk.dmg + aBuff.atkBonus) * aBuff.atkMult * burnMult * (rawMult || 1)));
    attacker.cur  = Math.max(0, attacker.cur - dmg);
    log.push({ text: `反彈鏡！攻擊被反彈，${attacker.name} 承受了 ${dmg} 傷害！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; dBuff.shield = 0;
    return { damage: dmg, mult: 1 };
  }

  const mult = srvEff(atkType, defender.type, defender.type2);
  const stabMult = (atkType === attacker.type || (attacker.type2 && atkType === attacker.type2)) ? 1.5 : 1;
  const stadiumBonus = G?.activeStadium?.id === 'stadium-training' ? 20 : 0;
  const reversalBonus = G?.activeStadium?.id === 'stadium-reversal' && attacker.cur <= attacker.hp * 0.5 ? 30 : 0;
  let damage;
  if (mult === 0) {
    damage = 0;
    log.push({ text: `${atk.name} 對 ${defender.name} 完全無效！`, cls: 'resist' });
  } else {
    damage = Math.max(1, Math.floor((atk.dmg + aBuff.atkBonus + stadiumBonus + reversalBonus) * aBuff.atkMult * burnMult * mult * stabMult) - dBuff.shield);
    defender.cur = Math.max(0, defender.cur - damage);

    if (stabMult > 1)     log.push({ text: `屬性加成！×1.5`, cls: 'super' });
    if (mult >= 4)        log.push({ text: `超超級有效！(×4)`, cls: 'super' });
    else if (mult >= 2)   log.push({ text: `超級有效！`, cls: 'super' });
    else if (mult <= 0.5) log.push({ text: `效果不佳…`, cls: 'resist' });
    log.push({ text: `${attacker.name} 使用了 ${atk.name}，造成 ${damage} 傷害！`, cls: 'attack' });

    // Fire thaws freeze
    if (damage > 0 && atkType === 'fire' && defender.status?.type === 'freeze') {
      defender.status = null;
      log.push({ text: `被火焰融化，${defender.name} 從結凍中解脫！`, cls: 'special' });
    }
    // Inflict status
    if (damage > 0 && atk.status && !defender.status && defender.cur > 0 && Math.random() < atk.status.chance) {
      const effect    = atk.status.effect;
      const turnsLeft = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                      : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                      : 999;
      defender.status = { type: effect, turnsLeft };
      log.push({ text: `${defender.name} 陷入了${STATUS_ZH[effect]}！`, cls: 'special' });
    }
  }

  // Consume buffs
  aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; dBuff.shield = 0;
  return { damage, mult };
}

// Applies a trainer card effect to the given role's side.
function applyTrainer(card, role, G, log) {
  const op     = role === 'p1' ? 'p2' : 'p1';
  const deck   = G[`${role}Deck`];
  const idx    = G[`${role}Idx`];
  const buff   = G[`${role}Buff`];
  const active = deck[idx];

  switch (card.id) {
    case 'potion':
      active.cur = Math.min(active.hp, active.cur + 80);
      log.push({ text: `使用了傷藥，${active.name} 回復 80 HP！`, cls: 'system' });
      break;
    case 'x-atk':
      buff.atkBonus += 40;
      log.push({ text: `使用了攻擊強化，下次攻擊 +40 傷害！`, cls: 'system' });
      break;
    case 'x-def':
      buff.shield += 40;
      log.push({ text: `使用了防禦強化，下次承受傷害 -40！`, cls: 'system' });
      break;
    case 'energize':
      buff.atkMult *= 2;
      active.cur = Math.max(1, active.cur - 50);
      log.push({ text: `使用了能量強化，下次攻擊傷害 ×2！但 ${active.name} 損失 50 HP！`, cls: 'system' });
      break;
    case 'revive': {
      const di = deck.findIndex((p, i) => i !== idx && p.cur <= 0);
      if (di >= 0) { deck[di].cur = 80; log.push({ text: `${deck[di].name} 被復活了！`, cls: 'system' }); }
      else log.push({ text: `沒有可復活的寶可夢！`, cls: 'system' });
      break;
    }
    case 'antidote':
      if (active.status) {
        const st = STATUS_ZH[active.status.type] || active.status.type;
        active.status = null;
        log.push({ text: `萬能藥解除了 ${active.name} 的${st}！`, cls: 'system' });
      }
      break;
    case 'nurse':
      active.cur = active.hp; active.status = null;
      log.push({ text: `治療師讓 ${active.name} 完全回復！`, cls: 'system' });
      break;
    case 'switch':
      G[`${role}FreeSwitch`] = true;
      log.push({ text: `使用換人命令，可免費換場！`, cls: 'system' });
      break;
    case 'all-out':
      buff.atkMult *= 3;
      log.push({ text: `使用了全力出擊，下次攻擊傷害 ×3！`, cls: 'system' });
      break;
    case 'fire-bomb': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (!opActive.status) { opActive.status = { type: 'burn', turnsLeft: 999 }; log.push({ text: `火焰彈讓 ${opActive.name} 陷入燒傷！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 已有異常狀態，火焰彈無效！`, cls: 'system' });
      break;
    }
    case 'gas-attack': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (!opActive.status) { opActive.status = { type: 'poison', turnsLeft: 999 }; log.push({ text: `瓦斯攻擊讓 ${opActive.name} 陷入中毒！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 已有異常狀態，瓦斯攻擊無效！`, cls: 'system' });
      break;
    }
    case 'switcher': {
      const opRole    = op;
      const opDeck    = G[`${opRole}Deck`];
      const opIdx     = G[`${opRole}Idx`];
      const aliveOpts = opDeck.map((_,i)=>i).filter(i => i !== opIdx && opDeck[i].cur > 0);
      if (aliveOpts.length > 0) {
        const newIdx = aliveOpts[Math.floor(Math.random() * aliveOpts.length)];
        G[`${opRole}Idx`] = newIdx;
        log.push({ text: `交換器強制換出 ${opDeck[newIdx].name} 上場！`, cls: 'special' });
      } else {
        log.push({ text: `對手沒有可換的備戰寶可夢！`, cls: 'system' });
      }
      break;
    }
    case 'reflect':
      buff.reflect = true;
      log.push({ text: `設置了反彈鏡！下次對手攻擊將反彈！`, cls: 'special' });
      break;
    case 'orb-fire':    buff.typeOverride = 'fire';    log.push({ text: `火焰寶珠：本回合攻擊改為火屬性！`, cls: 'system' }); break;
    case 'orb-water':   buff.typeOverride = 'water';   log.push({ text: `水流寶珠：本回合攻擊改為水屬性！`, cls: 'system' }); break;
    case 'orb-elec':    buff.typeOverride = 'electric'; log.push({ text: `電氣寶珠：本回合攻擊改為電屬性！`, cls: 'system' }); break;
    case 'orb-psychic': buff.typeOverride = 'psychic'; log.push({ text: `超能寶珠：本回合攻擊改為超能屬性！`, cls: 'system' }); break;
    case 'orb-ice':     buff.typeOverride = 'ice';     log.push({ text: `冰晶寶珠：本回合攻擊改為冰屬性！`, cls: 'system' }); break;
    case 'orb-dragon':  buff.typeOverride = 'dragon';  log.push({ text: `龍紋寶珠：本回合攻擊改為龍屬性！`, cls: 'system' }); break;
    case 'orb-dark':    buff.typeOverride = 'dark';    log.push({ text: `暗影寶珠：本回合攻擊改為惡屬性！`, cls: 'system' }); break;
    case 'orb-fairy':   buff.typeOverride = 'fairy';   log.push({ text: `妖精寶珠：本回合攻擊改為妖精屬性！`, cls: 'system' }); break;
    case 'stadium-training':
    case 'stadium-spring':
    case 'stadium-reversal': {
      const old = G.activeStadium;
      G.activeStadium = card;
      if (old) log.push({ text: `新競技場【${card.name}】取代了【${old.name}】！`, cls: 'special' });
      else log.push({ text: `【${card.name}】競技場開場！`, cls: 'special' });
      break;
    }
  }
}

// Draws 1-2 cards for each player after a turn.
function drawForBoth(G) {
  // Hot Springs: heal both active Pokémon 15 HP each turn
  if (G.activeStadium?.id === 'stadium-spring') {
    for (const role of ['p1', 'p2']) {
      const poke = G[`${role}Deck`][G[`${role}Idx`]];
      if (poke.cur > 0 && poke.cur < poke.hp) {
        poke.cur = Math.min(poke.hp, poke.cur + 15);
      }
    }
  }
  const itemsOnly = TRAINERS.filter(c => c.cat !== 'supporter');
  for (const role of ['p1', 'p2']) {
    const drawPool = itemsOnly;
    const n = Math.floor(Math.random() * 2) + 1;
    for (let i = 0; i < n; i++) {
      G[`${role}Hand`].push(drawPool[Math.floor(Math.random() * drawPool.length)]);
    }
    G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 5;
  }
}

/* ═══════════════════════════════════════════
   ROOM MANAGEMENT
═══════════════════════════════════════════ */
const rooms = new Map();

function genCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function freshBuff() { return { atkBonus:0, atkMult:1, shield:0, typeOverride:null, reflect:false }; }

function buildG(room) {
  const firstTurn = Math.random() < 0.5 ? 'p1' : 'p2';
  room.coinFlip   = firstTurn;
  return {
    p1Deck: room.p1Team.map(clonePoke),
    p2Deck: room.p2Team.map(clonePoke),
    p1Idx: 0, p2Idx: 0,
    round:  1,
    turn:   firstTurn,
    pendingKOSwitch: null,
    p1Hand: dealHand(3), p2Hand: dealHand(3),
    p1SuppUsed: false, p1SuppStageUsed: 0,
    p2SuppUsed: false, p2SuppStageUsed: 0,
    p1FreeSwitch: false, p2FreeSwitch: false,
    p1Buff: freshBuff(), p2Buff: freshBuff(),
    p1NeedsDiscard: false, p2NeedsDiscard: false,
    activeStadium: null,
    winner: null,
  };
}

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  send(room.p1, msg); send(room.p2, msg);
}

function randomRoster() {
  return [...POKEMON].sort(() => Math.random() - 0.5).slice(0, 6);
}

/* ═══════════════════════════════════════════
   WEBSOCKET
═══════════════════════════════════════════ */
wss.on('connection', ws => {
  ws.roomCode = null;
  ws.role     = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try { handleMessage(ws, msg); } catch(e) { console.error('WS handler error:', e); }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const op = ws.role === 'p1' ? 'p2' : 'p1';
    send(room[op], { type: 'opponent_disconnected' });
    if (room.phase !== 'done') rooms.delete(ws.roomCode);
  });
});

function handleMessage(ws, msg) {
    const { type } = msg;

    /* ── Lobby ── */
    if (type === 'create_room') {
      const code   = genCode();
      const roster = randomRoster();
      const room   = { code, p1: ws, p2: null, phase: 'waiting', p1Roster: roster, p2Roster: null, p1Team: null, p2Team: null, p1Ready: false, p2Ready: false, G: null, p1Rerolls: 0, p2Rerolls: 0, coinFlip: null };
      rooms.set(code, room);
      ws.roomCode = code; ws.role = 'p1';
      send(ws, { type: 'room_created', code, role: 'p1', roster });
      return;
    }

    if (type === 'join_room') {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room)     { send(ws, { type: 'error', message: '找不到房間，請確認代碼' }); return; }
      if (room.p2)   { send(ws, { type: 'error', message: '房間已滿' }); return; }
      room.p2       = ws;
      ws.roomCode   = code; ws.role = 'p2';
      room.p2Roster = randomRoster();
      room.phase    = 'selecting';
      send(ws,      { type: 'joined', role: 'p2', roster: room.p2Roster });
      send(room.p1, { type: 'opponent_joined' });
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const role = ws.role;

    /* ── Team select ── */
    if (type === 'select_team') {
      const roster   = role === 'p1' ? room.p1Roster : room.p2Roster;
      const selected = (msg.indices || []).map(i => roster[i]).filter(Boolean);
      if (selected.length !== 3) { send(ws, { type: 'error', message: '請選擇 3 隻寶可夢' }); return; }
      if (role === 'p1') { room.p1Team = selected; room.p1Ready = true; }
      else               { room.p2Team = selected; room.p2Ready = true; }
      const op = role === 'p1' ? 'p2' : 'p1';
      send(room[op], { type: 'opponent_ready' });
      if (room.p1Ready && room.p2Ready) {
        room.G     = buildG(room);
        room.phase = 'battle';
        broadcast(room, { type: 'battle_start', state: room.G, coinFlip: room.coinFlip });
      }
      return;
    }

    if (type === 'reroll') {
      if (room.phase !== 'selecting' && room.phase !== 'waiting') return;
      const key = `${role}Rerolls`;
      if (room[key] >= 3) { send(ws, { type: 'error', message: '重新生成次數已用完！' }); return; }
      room[key]++;
      const newRoster = randomRoster();
      room[`${role}Roster`] = newRoster;
      send(ws, { type: 'roster_update', roster: newRoster, rerollsLeft: 3 - room[key] });
      return;
    }

    /* ── Battle ── */
    if (room.phase !== 'battle' || !room.G) return;
    const G   = room.G;
    const op  = role === 'p1' ? 'p2' : 'p1';

    // Trainer card
    if (type === 'use_trainer') {
      if (G.turn !== role) return;
      if (G.pendingKOSwitch) return;
      if (G[`${role}NeedsDiscard`]) return;
      const hand = G[`${role}Hand`];
      const card = hand[msg.handIdx];
      if (!card) return;
      if (card.cat === 'supporter' && G[`${role}SuppUsed`]) return;
      if (card.cat === 'supporter' && G[`${role}SuppStageUsed`] >= 2) {
        send(ws, { type: 'error', message: '本關支援者牌已達上限（2張）' }); return;
      }
      hand.splice(msg.handIdx, 1);
      if (card.cat === 'supporter') { G[`${role}SuppUsed`] = true; G[`${role}SuppStageUsed`]++; }
      const log = [];
      applyTrainer(card, role, G, log);
      broadcast(room, { type: 'update', state: G, log, actor: role });
      return;
    }

    // Discard
    if (type === 'discard') {
      if (!G[`${role}NeedsDiscard`]) return;
      const hand = G[`${role}Hand`];
      if (msg.handIdx < 0 || msg.handIdx >= hand.length) return;
      hand.splice(msg.handIdx, 1);
      G[`${role}NeedsDiscard`] = hand.length > 5;
      broadcast(room, { type: 'update', state: G, log: [], actor: role });
      return;
    }

    // Attack
    if (type === 'attack') {
      if (G.turn !== role || G.pendingKOSwitch) return;
      if (G[`${role}NeedsDiscard`] || G[`${op}NeedsDiscard`]) return;
      const attacker = G[`${role}Deck`][G[`${role}Idx`]];
      const defender = G[`${op}Deck`][G[`${op}Idx`]];
      const aBuff    = G[`${role}Buff`];
      const dBuff    = G[`${op}Buff`];
      const atk      = attacker.attacks[msg.idx];
      if (!atk) return;

      const log = [];
      const sResult = handleStatus(attacker, log);

      if (sResult.died) {
        // Attacker KO'd by own status
        const alive = G[`${role}Deck`].filter(p => p.cur > 0).length;
        if (alive === 0) {
          G.winner = op;
          broadcast(room, { type: 'game_over', winner: op, state: G, log });
          room.phase = 'done'; return;
        }
        G.pendingKOSwitch = role;
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      if (sResult.skipped) {
        G.turn = op;
        G[`${role}SuppUsed`] = false;
        G[`${role}FreeSwitch`] = false;
        drawForBoth(G);
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      doAttack(attacker, defender, atk, aBuff, dBuff, log, G);
      G[`${role}SuppUsed`]  = false;
      G[`${role}FreeSwitch`] = false;

      if (defender.cur <= 0) {
        const opAlive = G[`${op}Deck`].filter(p => p.cur > 0).length;
        if (opAlive === 0) {
          G.winner = role;
          drawForBoth(G);
          broadcast(room, { type: 'game_over', winner: role, state: G, log, atkType: atk.type });
          room.phase = 'done'; return;
        }
        G.pendingKOSwitch = op;
        G.turn = op;
      } else {
        G.turn = op;
        G.round++;
      }
      drawForBoth(G);
      broadcast(room, { type: 'update', state: G, log, actor: role, atkType: atk.type }); return;
    }

    // Regular switch (costs a turn)
    if (type === 'switch') {
      if (G.turn !== role || G.pendingKOSwitch) return;
      if (G[`${role}NeedsDiscard`]) return;
      const deck   = G[`${role}Deck`];
      const curIdx = G[`${role}Idx`];
      const newIdx = msg.deckIdx;
      if (newIdx === curIdx || !deck[newIdx] || deck[newIdx].cur <= 0) return;

      if (deck[curIdx].status?.type === 'confusion') deck[curIdx].status = null;
      G[`${role}Idx`] = newIdx;
      G[`${role}SuppUsed`]  = false;
      G[`${role}FreeSwitch`] = false;
      G.turn = op;
      G.round++;
      drawForBoth(G);
      const log = [{ text: `換上了 ${deck[newIdx].name}！`, cls: 'player' }];
      broadcast(room, { type: 'update', state: G, log, actor: role }); return;
    }

    // Free switch (after 換人命令)
    if (type === 'free_switch') {
      if (G.turn !== role || !G[`${role}FreeSwitch`]) return;
      const deck   = G[`${role}Deck`];
      const curIdx = G[`${role}Idx`];
      const newIdx = msg.deckIdx;
      if (newIdx === curIdx || !deck[newIdx] || deck[newIdx].cur <= 0) return;

      if (deck[curIdx].status?.type === 'confusion') deck[curIdx].status = null;
      G[`${role}Idx`] = newIdx;
      G[`${role}FreeSwitch`] = false;
      const log = [{ text: `免費換上了 ${deck[newIdx].name}！`, cls: 'system' }];
      broadcast(room, { type: 'update', state: G, log, actor: role }); return;
    }

    // KO switch (forced switch after being KO'd)
    if (type === 'ko_switch') {
      if (G.pendingKOSwitch !== role) return;
      const deck   = G[`${role}Deck`];
      const newIdx = msg.deckIdx;
      if (!deck[newIdx] || deck[newIdx].cur <= 0) return;

      G[`${role}Idx`] = newIdx;
      G.pendingKOSwitch = null;
      const log = [{ text: `${deck[newIdx].name} 上場！`, cls: 'system' }];
      broadcast(room, { type: 'update', state: G, log, actor: role }); return;
    }

    if (type === 'chat') {
      const text    = typeof msg.text    === 'string' ? msg.text.slice(0, 80) : null;
      const sticker = typeof msg.sticker === 'string' ? msg.sticker.slice(0, 10) : null;
      if (!text && !sticker) return;
      broadcast(room, { type: 'chat', role, text, sticker }); return;
    }
}

/* ═══════════════════════════════════════════
   DB + LISTEN
═══════════════════════════════════════════ */
async function initDB() {
  if (!pool) { console.log('No DB configured, running in-memory only'); return; }
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, created_at TIMESTAMPTZ DEFAULT NOW())`);
    console.log('PostgreSQL connected');
  } catch (e) {
    console.warn('PostgreSQL not available, running without DB:', e.message);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await initDB();
  console.log(`Server: http://localhost:${PORT}`);
});
