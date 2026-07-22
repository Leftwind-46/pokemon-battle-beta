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

// Neither Zeabur's managed Postgres nor local/throwaway Postgres (Homebrew, docker run
// postgres:16, etc.) speak SSL — don't force it. If a `DATABASE_URL` ever needs SSL, add
// `?sslmode=require` to the connection string itself; the `pg` driver honors that natively
// when no explicit `ssl` option overrides it.
const pool = pgUri
  ? new Pool({ connectionString: pgUri })
  : null;

app.use(express.static('public'));
app.use(express.json());

/* ═══════════════════════════════════════════
   GAME DATA  (mirrors pokemon_battle.html)
═══════════════════════════════════════════ */
const POKEMON = [
  // Tier 1
  { mega:{spriteId:10033, type:'grass', type2:'poison', ability:{id:'thick-fat', name:'厚脂肪', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}}, id:3,   name:'妙蛙花',     type:'grass',    type2:'poison',  hp:250, tier:1, ability:{id:'blaze-boost', name:'茂盛', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'集氣',cost:3,type:'grass',support:true,effect:'focus-energy',bonusEnergy:9},{name:'毒粉刺',dmg:84,cost:7,type:'poison',status:{effect:'poison', chance:0.35},megaBoost:true,bonusEnergy:5},{name:'葉刃',dmg:83,cost:7,type:'grass',megaBoost:true,bonusEnergy:5},{name:'大地之力',dmg:124,cost:12,type:'ground',status:{effect:'burn', chance:0.25}}]},
  { mega:{spriteId:10038, type:'ghost', type2:'poison', ability:{id:'frisk-ward', name:'踩影', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:94,  name:'耿鬼',       type:'ghost',    type2:'poison',  hp:220, tier:1, ability:{id:'poison-heal', name:'毒療', trigger:'onStatus', desc:'中毒時每回合回復 1/8 最大HP，而非扣血'}, attacks:[{name:'催眠術',dmg:71,cost:3,type:'psychic',status:{effect:'sleep', chance:0.5},megaBoost:true,bonusEnergy:6},{name:'幽靈之爪',dmg:72,cost:3,type:'ghost',status:{effect:'poison', chance:0.2},megaBoost:true,bonusEnergy:6},{name:'暗影球',dmg:118,cost:9,type:'ghost',megaBoost:true,bonusEnergy:7},{name:'影舞',cost:2,type:'ghost',support:true,effect:'shadow-dance'}]},
  { id:68,  name:'怪力',       type:'fighting', hp:260, tier:1, ability:{id:'guts', name:'毅力', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'動感拳',dmg:53,cost:2,type:'fighting',megaBoost:true,bonusEnergy:6},{name:'岩石滑落',dmg:92,cost:7,type:'rock',status:{effect:'paralysis', chance:0.15},megaBoost:true,bonusEnergy:5},{name:'詭計',cost:3,type:'fighting',support:true,effect:'trick'},{name:'超強衝擊',dmg:135,cost:12,type:'fighting',selfHeal:0.21}]},
  { mega:{spriteId:10037, type:'psychic', type2:null, ability:{id:'trace', name:'複製', trigger:'onEnter', desc:'上場時複製對手當前的特性'}}, id:65,  name:'胡地',       type:'psychic',  hp:200, tier:1, ability:{id:'sync-status', name:'同步', trigger:'onDefend', desc:'陷入中毒／麻痺／燒傷時，會將該狀態傳染給攻擊者'}, attacks:[{name:'超能力',dmg:67,cost:1,type:'psychic',status:{effect:'confusion', chance:0.3},megaBoost:true,bonusEnergy:5},{name:'念力',dmg:66,cost:0,type:'psychic',status:{effect:'confusion', chance:0.25},megaBoost:true,bonusEnergy:4},{name:'暗影球',dmg:102,cost:6,type:'ghost',megaBoost:true,bonusEnergy:4},{name:'詭計',cost:3,type:'psychic',support:true,effect:'trick'}]},
  { mega:{spriteId:10304, type:'electric', type2:null, ability:{id:'motor-drive', name:'電氣場地', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:26,  name:'雷丘',       type:'electric', hp:200, tier:1, ability:{id:'static', name:'靜電', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入麻痺'}, attacks:[{name:'衝撞',dmg:60,cost:0,type:'normal',megaBoost:true,bonusEnergy:4},{name:'十萬伏特',dmg:60,cost:1,type:'electric',status:{effect:'paralysis', chance:0.3},megaBoost:true,bonusEnergy:5},{name:'電磁衝浪',dmg:120,cost:6,type:'electric',status:{effect:'paralysis', chance:0.2},megaBoost:true,bonusEnergy:4},{name:'撐住',cost:5,type:'electric',support:true,effect:'brace'}]},
  { mega:{spriteId:10076, type:'steel', type2:'psychic', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:376, name:'巨金怪',     type:'steel',    type2:'psychic', hp:260, tier:1, ability:{id:'solid-rock', name:'硬岩', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'子彈拳',dmg:60,cost:3,type:'steel',megaBoost:true,bonusEnergy:6},{name:'劍舞',cost:4,type:'steel',support:true,effect:'sword-dance'},{name:'閃光炮',dmg:100,cost:8,type:'steel',megaBoost:true,bonusEnergy:6},{name:'隕石衝擊',dmg:143,cost:13,type:'rock',selfHeal:0.25}]},
  { mega:{spriteId:10059, type:'fighting', type2:'steel', ability:{id:'adaptability', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:448, name:'路卡利歐',   type:'fighting', type2:'steel',   hp:220, tier:1, ability:{id:'guts', name:'堅韌', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'擾亂精神',cost:1,type:'fighting',support:true,effect:'debuff',status:{effect:'confusion', chance: 1}},{name:'金屬爪',dmg:74,cost:3,type:'steel',megaBoost:true,bonusEnergy:6},{name:'龍之脈動',dmg:115,cost:8,type:'dragon',megaBoost:true,bonusEnergy:6},{name:'暗影球',dmg:168,cost:14,type:'ghost',selfHeal:0.18}]},
  { mega:{spriteId:10041, type:'water', type2:'dark', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對方的防禦型特性'}}, id:130, name:'暴鯉龍',     type:'water',    type2:'flying',  hp:260, tier:1, ability:{id:'no-weakness-dodge', name:'深淵支配', trigger:'onDefend', desc:'不會受到超效傷害；10% 機率完全閃避攻擊'}, attacks:[{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'},{name:'龍息',dmg:94,cost:8,type:'water',megaBoost:true,bonusEnergy:6},{name:'怒風',dmg:93,cost:8,type:'flying',megaBoost:true,bonusEnergy:6},{name:'咬碎',dmg:137,cost:13,type:'dark',status:{effect:'sleep', chance:0.2}}]},
  { id:87,  name:'白海獅',     type:'water',    type2:'ice',     hp:240, tier:1, ability:{id:'legacy-boost', name:'指揮', trigger:'onLeave', desc:'陣亡或被換下場時，下一隻上場的我方寶可夢首次攻擊：能量消耗×0.5、傷害+40'}, attacks:[{name:'冷凍光線',dmg:61,cost:3,type:'ice',status:{effect:'freeze', chance:0.15},megaBoost:true,bonusEnergy:5},{name:'集氣',cost:3,type:'water',support:true,effect:'focus-energy',bonusEnergy:9},{name:'大浪',dmg:100,cost:6,type:'water',megaBoost:true,bonusEnergy:4},{name:'衝浪',dmg:148,cost:11,type:'water',status:{effect:'confusion', chance:0.25}}]},
  { id:82,  name:'三合一磁怪',   type:'electric', type2:'steel',   hp:210, tier:1, ability:{id:'item-synergy', name:'機械之心', trigger:'onAttack', desc:'本回合使用過道具卡時，攻擊傷害 +40'}, attacks:[{name:'電磁炮',dmg:65,cost:2,type:'electric',status:{effect:'paralysis', chance:0.3},megaBoost:true,bonusEnergy:6},{name:'集氣',cost:3,type:'electric',support:true,effect:'focus-energy',bonusEnergy:9},{name:'電磁衝浪',dmg:108,cost:8,type:'electric',status:{effect:'paralysis', chance:0.2},megaBoost:true,bonusEnergy:6},{name:'閃光炮',dmg:157,cost:12,type:'steel',selfHeal:0.18}]},
  { id:28,  name:'穿山王',     type:'ground',   hp:240, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'灼熱',cost:1,type:'ground',support:true,effect:'debuff',status:{effect:'burn', chance: 1}},{name:'地震',dmg:100,cost:6,type:'ground',megaBoost:true,bonusEnergy:4},{name:'岩石碎裂',dmg:96,cost:6,type:'rock',megaBoost:true,bonusEnergy:4},{name:'岩石滑落',dmg:144,cost:11,type:'rock',status:{effect:'sleep', chance:0.2}}]},
  { mega:{spriteId:10071, type:'water', type2:'psychic', ability:{id:'sturdy', name:'硬殼盔甲', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}}, id:80,  name:'呆殼獸',     type:'water',    type2:'psychic', hp:260, tier:1, ability:{id:'own-tempo', name:'我行我素', trigger:'onDefend', desc:'不會陷入混亂狀態'}, attacks:[{name:'衝浪',dmg:53,cost:2,type:'water',megaBoost:true,bonusEnergy:6},{name:'精神強擊',dmg:88,cost:7,type:'psychic',status:{effect:'confusion', chance:0.2},megaBoost:true,bonusEnergy:5},{name:'冰凍吐息',cost:3,type:'water',support:true,effect:'debuff',status:{effect:'freeze', chance:1}},{name:'念力',dmg:129,cost:13,type:'psychic',status:{effect:'confusion', chance:0.25}}]},
  { id:823, name:'鋼鎧鴉',     type:'steel',    type2:'flying',  hp:250, tier:1, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'鐵翼',dmg:57,cost:1,type:'steel',megaBoost:true,bonusEnergy:5},{name:'鋼鐵身壓',dmg:84,cost:7,type:'steel',megaBoost:true,bonusEnergy:5},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'},{name:'颶風飛翔',dmg:122,cost:12,type:'flying',selfHeal:0.28}]},
  { mega:{spriteId:10283, type:'water', type2:'dragon', ability:{id:'adaptability', name:'龍化', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:160, name:'大力鱷',     type:'water',    hp:260, tier:1, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'冥想',cost:3,type:'water',support:true,effect:'meditate'},{name:'冰凍拳',dmg:91,cost:8,type:'ice',status:{effect:'freeze', chance:0.1},megaBoost:true,bonusEnergy:6},{name:'衝浪',dmg:87,cost:7,type:'water',megaBoost:true,bonusEnergy:5},{name:'水砲',dmg:132,cost:12,type:'water',status:{effect:'paralysis', chance:0.2}}]},
  { mega:{spriteId:10294, type:'water', type2:'dark', ability:{id:'adaptability', name:'變幻自如', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:658, name:'甲賀忍蛙',       type:'water',    type2:'dark',    hp:220, tier:1, ability:{id:'rough-skin', name:'粗糙皮膚', trigger:'onDefend', desc:'受到攻擊傷害時，反彈攻擊者 1/8 最大HP 傷害'}, attacks:[{name:'水手裏劍',dmg:67,cost:3,type:'water',megaBoost:true,bonusEnergy:6},{name:'夜斬',dmg:74,cost:3,type:'dark',megaBoost:true,bonusEnergy:6},{name:'暗影球',dmg:119,cost:9,type:'ghost',megaBoost:true,bonusEnergy:7},{name:'電磁波',cost:1,type:'water',support:true,effect:'debuff',status:{effect:'paralysis', chance: 1}}]},
  // Tier 2
  { mega:{spriteId:10034, type:'fire', type2:'dragon', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:6,   name:'噴火龍',     type:'fire',     type2:'flying',  hp:290, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'火焰噴射',dmg:56,cost:2,type:'fire',status:{effect:'burn', chance:0.25},megaBoost:true,bonusEnergy:6},{name:'龍息',dmg:88,cost:7,type:'dragon',megaBoost:true,bonusEnergy:5},{name:'火焰衝擊',dmg:125,cost:12,type:'fire',status:{effect:'paralysis', chance:0.2}},{name:'破空飛翔',dmg:130,cost:12,type:'flying',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10036, type:'water', type2:null, ability:{id:'huge-power', name:'超級發射器', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:9,   name:'水箭龜',     type:'water',    hp:280, tier:2, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'水砲',dmg:50,cost:0,type:'water',megaBoost:true,bonusEnergy:4},{name:'影舞',cost:2,type:'water',support:true,effect:'shadow-dance'},{name:'衝浪',dmg:120,cost:11,type:'water',selfHeal:0.28},{name:'冰凍光束',dmg:123,cost:11,type:'ice',selfHeal:0.29}]},
  { mega:{spriteId:10043, type:'psychic', type2:'fighting', ability:{id:'guts', name:'不屈之心', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:150, name:'超夢',       type:'psychic',  hp:320, tier:2, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'念力衝擊',dmg:80,cost:6,type:'psychic',status:{effect:'confusion', chance:0.3},megaBoost:true,bonusEnergy:4},{name:'氣功拳',dmg:120,cost:11,type:'fighting',selfHeal:0.19},{name:'閃電拳',dmg:120,cost:11,type:'electric',status:{effect:'sleep', chance:0.2}},{name:'暗影球',dmg:123,cost:11,type:'ghost',status:{effect:'poison', chance:0.3}}]},
  { mega:{spriteId:10281, type:'dragon', type2:'flying', ability:{id:'multiscale', name:'多重鱗片', trigger:'onDefend', desc:'HP 全滿時，受到的攻擊傷害 ×0.9'}}, id:149, name:'快龍',       type:'dragon',   type2:'flying',  hp:320, tier:2, ability:{id:'multiscale', name:'多重鱗片', trigger:'onDefend', desc:'HP 全滿時，受到的攻擊傷害 ×0.9'}, attacks:[{name:'龍息',dmg:82,cost:6,type:'dragon',megaBoost:true,bonusEnergy:4},{name:'雷電',dmg:124,cost:12,type:'electric',status:{effect:'paralysis', chance:0.25}},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'},{name:'破壞光線',dmg:126,cost:11,type:'normal',status:{effect:'paralysis', chance:0.3}}]},
  { id:143, name:'卡比獸',     type:'normal',   hp:380, tier:2, ability:{id:'normal-domain', name:'神域支配', trigger:'onEnter', desc:'上場時場地切換為莊嚴神社；一般屬性攻擊傷害額外 +40'}, attacks:[{name:'磚塊',dmg:78,cost:13,type:'rock',megaBoost:true,bonusEnergy:8},{name:'連踢',dmg:99,cost:14,type:'normal',selfHeal:0.25},{name:'地震',dmg:99,cost:14,type:'ground',status:{effect:'freeze', chance:0.15}},{name:'破壞光線',dmg:99,cost:14,type:'normal',selfHeal:0.29}]},
  { id:59,  name:'風速狗',     type:'fire',     hp:260, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'夜斬',dmg:52,cost:1,type:'dark',megaBoost:true,bonusEnergy:5},{name:'影舞',cost:2,type:'fire',support:true,effect:'shadow-dance'},{name:'衝撞',dmg:90,cost:7,type:'normal',megaBoost:true,bonusEnergy:5},{name:'噴射火焰',dmg:127,cost:12,type:'fire',status:{effect:'burn', chance:0.25}}]},
  { id:131, name:'拉普拉斯',   type:'water',    type2:'ice',     hp:290, tier:2, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'衝浪',dmg:52,cost:1,type:'water',megaBoost:true,bonusEnergy:5},{name:'冷凍光線',dmg:85,cost:7,type:'ice',status:{effect:'freeze', chance:0.15},megaBoost:true,bonusEnergy:5},{name:'雷電',dmg:132,cost:12,type:'electric',selfHeal:0.21},{name:'暴風雪',dmg:125,cost:13,type:'ice',selfHeal:0.17}]},
  { mega:{spriteId:10058, type:'dragon', type2:'ground', ability:{id:'blaze-boost', name:'沙之力', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:445, name:'烈咬陸鯊',   type:'dragon',   type2:'ground',  hp:280, tier:2, ability:{id:'frisk-ward', name:'沙隱', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'龍爪',dmg:53,cost:1,type:'dragon',megaBoost:true,bonusEnergy:5},{name:'集氣',cost:3,type:'dragon',support:true,effect:'focus-energy',bonusEnergy:9},{name:'地震',dmg:125,cost:11,type:'ground',selfHeal:0.23},{name:'龍之隕星',dmg:123,cost:11,type:'dragon',status:{effect:'poison', chance:0.3}}]},
  { id:210, name:'布魯皇',     type:'fairy',    hp:300, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'仙女之力',dmg:61,cost:3,type:'fairy',megaBoost:true,bonusEnergy:6},{name:'雷電',dmg:94,cost:8,type:'electric',status:{effect:'paralysis', chance:0.15},megaBoost:true,bonusEnergy:6},{name:'咬碎',dmg:143,cost:14,type:'dark',status:{effect:'sleep', chance:0.2}},{name:'地震',dmg:138,cost:13,type:'ground',status:{effect:'confusion', chance:0.25}}]},
  { id:700, name:'仙子伊布',   type:'fairy',    hp:300, tier:2, ability:{id:'frisk-ward', name:'迷人之軀', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'妖精風',dmg:61,cost:3,type:'fairy',megaBoost:true,bonusEnergy:6},{name:'冰凍光束',dmg:95,cost:9,type:'ice',status:{effect:'freeze', chance:0.15},megaBoost:true,bonusEnergy:7},{name:'月亮力量',dmg:141,cost:13,type:'fairy',status:{effect:'poison', chance:0.3}},{name:'暗影球',dmg:137,cost:14,type:'ghost',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10285, type:'ice', type2:'ghost', ability:{id:'solid-rock', name:'降雪', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:478, name:'雪妖女',     type:'ice',      type2:'ghost',   hp:280, tier:2, ability:{id:'frisk-ward', name:'雪隱', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'冰凍光束',dmg:51,cost:0,type:'ice',status:{effect:'freeze', chance:0.15},megaBoost:true,bonusEnergy:4},{name:'怒風',dmg:82,cost:6,type:'flying',megaBoost:true,bonusEnergy:4},{name:'冰耳光',dmg:122,cost:11,type:'ice',status:{effect:'sleep', chance:0.2}},{name:'冥想',cost:3,type:'ice',support:true,effect:'meditate'}]},
  { id:614, name:'凍原熊',     type:'ice',      hp:320, tier:2, ability:{id:'frisk-ward', name:'雪隱', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'冰耳光',dmg:88,cost:7,type:'ice',status:{effect:'freeze', chance:0.15},megaBoost:true,bonusEnergy:5},{name:'大浪',dmg:126,cost:12,type:'water',status:{effect:'poison', chance:0.3}},{name:'暴風雪',dmg:126,cost:11,type:'ice',status:{effect:'burn', chance:0.25}},{name:'地震',dmg:128,cost:12,type:'ground',status:{effect:'poison', chance:0.3}}]},
  { id:430, name:'烏鴉頭頭',     type:'dark',     type2:'flying',  hp:300, tier:2, ability:{id:'insomnia', name:'不眠', trigger:'onDefend', desc:'不會陷入睡眠狀態'}, attacks:[{name:'夜斬',dmg:61,cost:3,type:'dark',megaBoost:true,bonusEnergy:6},{name:'夜騷動',dmg:100,cost:8,type:'dark',megaBoost:true,bonusEnergy:6},{name:'空氣斬',dmg:145,cost:14,type:'flying',selfHeal:0.22},{name:'怒風',dmg:139,cost:14,type:'flying',status:{effect:'poison', chance:0.3}}]},
  { id:466, name:'電擊魔獸',   type:'electric', hp:300, tier:2, ability:{id:'motor-drive', name:'電氣引擎', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'電磁衝浪',dmg:56,cost:3,type:'electric',status:{effect:'paralysis', chance:0.25},megaBoost:true,bonusEnergy:6},{name:'動感拳',dmg:96,cost:8,type:'fighting',megaBoost:true,bonusEnergy:6},{name:'十萬伏特',dmg:138,cost:14,type:'electric',selfHeal:0.18},{name:'冰凍拳',dmg:138,cost:14,type:'ice',status:{effect:'poison', chance:0.3}}]},
  { id:467, name:'鴨嘴炎獸',   type:'fire',     hp:300, tier:2, ability:{id:'flame-body', name:'火焰之軀', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入燒傷'}, attacks:[{name:'火焰衝擊',dmg:63,cost:3,type:'fire',status:{effect:'burn', chance:0.25},megaBoost:true,bonusEnergy:6},{name:'地震',dmg:98,cost:9,type:'ground',megaBoost:true,bonusEnergy:7},{name:'噴射火焰',dmg:141,cost:14,type:'fire',status:{effect:'paralysis', chance:0.2}},{name:'雷電',dmg:143,cost:14,type:'electric',status:{effect:'poison', chance:0.3}}]},
  { id:157, name:'火爆獸',     type:'fire',                      hp:260, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'詭計',cost:3,type:'fire',support:true,effect:'trick'},{name:'地震',dmg:91,cost:9,type:'ground',megaBoost:true,bonusEnergy:7},{name:'爆炸火焰',dmg:94,cost:9,type:'fire',megaBoost:true,bonusEnergy:7},{name:'烈火強衝',dmg:136,cost:13,type:'fire',status:{effect:'poison', chance:0.3}}]},
  { mega:{spriteId:10282, type:'grass', type2:'fairy', ability:{id:'huge-power', name:'太陽核心', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:154, name:'大竺葵',     type:'grass',                     hp:270, tier:2, ability:{id:'blaze-boost', name:'茂盛', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'詭計',cost:3,type:'grass',support:true,effect:'trick'},{name:'大地之力',dmg:103,cost:10,type:'ground',megaBoost:true,bonusEnergy:8},{name:'花瓣風暴',dmg:102,cost:9,type:'grass',megaBoost:true,bonusEnergy:7},{name:'葉刃',dmg:145,cost:15,type:'grass',status:{effect:'paralysis', chance:0.2}}]},
  // Tier 3
  { id:383, name:'固拉多',     type:'ground',   hp:340, tier:3, ability:{id:'drought-lava', name:'熔岩大地', trigger:'onEnter', desc:'上場時場地切換為熔岩火山；地面／火屬性攻擊傷害額外 +40'}, attacks:[{name:'地震',dmg:67,cost:11,type:'ground',megaBoost:true,bonusEnergy:6},{name:'岩石碎裂',dmg:83,cost:10,type:'rock',selfHeal:0.22},{name:'火焰噴射',dmg:83,cost:10,type:'fire',status:{effect:'confusion', chance:0.25}},{name:'原始大地',dmg:83,cost:10,type:'fire',selfHeal:0.26}]},
  { id:382, name:'蓋歐卡',     type:'water',    hp:340, tier:3, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'源起之波',dmg:65,cost:10,type:'water',megaBoost:true,bonusEnergy:5},{name:'雷電',dmg:82,cost:10,type:'electric',status:{effect:'burn', chance:0.25}},{name:'大浪',dmg:80,cost:9,type:'water',selfHeal:0.16},{name:'原始海洋',dmg:80,cost:9,type:'ice',selfHeal:0.21}]},
  { mega:{spriteId:10079, type:'dragon', type2:'flying', ability:{id:'solid-rock', name:'德爾塔氣流', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:384, name:'烈空坐',     type:'dragon',   type2:'flying',  hp:360, tier:3, ability:{id:'weaken-buffs', name:'威壓氣場', trigger:'onDefend', desc:'對手的攻擊力提升效果減半'}, attacks:[{name:'神速',dmg:74,cost:12,type:'normal',megaBoost:true,bonusEnergy:7},{name:'火焰噴射',dmg:86,cost:11,type:'fire',status:{effect:'freeze', chance:0.15}},{name:'怒風',dmg:86,cost:11,type:'flying',status:{effect:'poison', chance:0.3}},{name:'龍之隕星',dmg:86,cost:11,type:'dragon',status:{effect:'burn', chance:0.25}}]},
  { id:1008,name:'密勒頓',     type:'electric', type2:'dragon',  hp:360, tier:3, ability:{id:'blaze-boost', name:'強子引擎', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'電磁衝浪',dmg:77,cost:12,type:'electric',status:{effect:'paralysis', chance:0.25},megaBoost:true,bonusEnergy:7},{name:'龍息',dmg:86,cost:11,type:'dragon',selfHeal:0.17},{name:'電磁炮',dmg:86,cost:11,type:'electric',status:{effect:'poison', chance:0.3}},{name:'未來雷霆',dmg:86,cost:11,type:'psychic',selfHeal:0.23}]},
  { id:250, name:'鳳王',       type:'fire',     type2:'flying',  hp:340, tier:3, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'聖焰',dmg:70,cost:11,type:'fire',status:{effect:'burn', chance:0.3},megaBoost:true,bonusEnergy:6},{name:'怒風',dmg:84,cost:9,type:'flying',status:{effect:'paralysis', chance:0.2}},{name:'超能力',dmg:84,cost:9,type:'psychic',selfHeal:0.27},{name:'神聖之焰',dmg:84,cost:9,type:'flying',selfHeal:0.2}]},
  { id:249, name:'洛奇亞',     type:'psychic',  type2:'flying',  hp:340, tier:3, ability:{id:'psychic-domain', name:'幻境支配', trigger:'onEnter', desc:'上場時場地切換為魔幻空間；超能力屬性攻擊傷害額外 +40'}, attacks:[{name:'怒風',dmg:69,cost:11,type:'flying',megaBoost:true,bonusEnergy:6},{name:'冰凍光束',dmg:81,cost:12,type:'ice',status:{effect:'confusion', chance:0.25}},{name:'暴風',dmg:81,cost:12,type:'flying',status:{effect:'sleep', chance:0.2}},{name:'心靈衝擊',dmg:81,cost:12,type:'psychic',status:{effect:'freeze', chance:0.15}}]},
  { id:1007,name:'故勒頓',     type:'fighting', type2:'dragon',  hp:360, tier:3, ability:{id:'blaze-boost', name:'緋紅脈動', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'決勝衝擊',dmg:74,cost:12,type:'fighting',megaBoost:true,bonusEnergy:7},{name:'火焰噴射',dmg:83,cost:10,type:'fire',status:{effect:'burn', chance:0.25}},{name:'地震',dmg:83,cost:10,type:'ground',status:{effect:'sleep', chance:0.2}},{name:'遠古之力',dmg:83,cost:10,type:'rock',selfHeal:0.3}]},
  { mega:{spriteId:10051, type:'psychic', type2:'fairy', ability:{id:'adaptability', name:'妖精皮膚', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:282, name:'沙奈朵',     type:'psychic',  type2:'fairy',   hp:320, tier:3, ability:{id:'sync-status', name:'同步', trigger:'onDefend', desc:'陷入中毒／麻痺／燒傷時，會將該狀態傳染給攻擊者'}, attacks:[{name:'妖精之力',dmg:83,cost:6,type:'fairy',megaBoost:true,bonusEnergy:4},{name:'暗影球',dmg:120,cost:11,type:'ghost',selfHeal:0.26},{name:'月亮力量',dmg:124,cost:11,type:'fairy',status:{effect:'poison', chance:0.3}},{name:'精神強擊',dmg:123,cost:11,type:'psychic',selfHeal:0.24}]},
  { id:144, name:'急凍鳥',     type:'ice',      type2:'flying',  hp:340, tier:3, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'暴風雪',dmg:72,cost:11,type:'ice',status:{effect:'freeze', chance:0.25},megaBoost:true,bonusEnergy:6},{name:'冷凍光線',dmg:86,cost:11,type:'ice',status:{effect:'sleep', chance:0.2}},{name:'暴風',dmg:86,cost:11,type:'flying',selfHeal:0.22},{name:'怒風',dmg:86,cost:11,type:'flying',selfHeal:0.25}]},
  { id:145, name:'閃電鳥',     type:'electric', type2:'flying',  hp:340, tier:3, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'雷霆',dmg:66,cost:11,type:'electric',status:{effect:'paralysis', chance:0.3},megaBoost:true,bonusEnergy:6},{name:'電磁衝浪',dmg:89,cost:12,type:'electric',status:{effect:'sleep', chance:0.2}},{name:'雷電',dmg:73,cost:12,type:'electric',selfHeal:0.25},{name:'怒風',dmg:89,cost:8,type:'flying',status:{effect:'paralysis', chance:0.2}}]},
  { id:146, name:'火焰鳥',     type:'fire',     type2:'flying',  hp:340, tier:3, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'火焰衝擊',dmg:72,cost:11,type:'fire',status:{effect:'burn', chance:0.3},megaBoost:true,bonusEnergy:6},{name:'超能力',dmg:76,cost:9,type:'psychic',selfHeal:0.16},{name:'噴射火焰',dmg:76,cost:9,type:'fire',status:{effect:'paralysis', chance:0.2}},{name:'怒風',dmg:76,cost:9,type:'flying',selfHeal:0.28}]},
  { id:888,name:'蒼響',      type:'fairy',    type2:'steel',   hp:370, tier:3, ability:{id:'huge-power', name:'不撓之劍', trigger:'onAttack', desc:'攻擊傷害固定 +40'}, attacks:[{name:'鐵頭功',dmg:78,cost:13,type:'steel',megaBoost:true,bonusEnergy:8},{name:'剛劍',dmg:94,cost:11,type:'steel',selfHeal:0.19},{name:'接近戰',dmg:94,cost:11,type:'fighting',selfHeal:0.21},{name:'神秘劍',dmg:94,cost:11,type:'fairy',selfHeal:0.18}]},
  { id:716, name:'哲爾尼亞斯', type:'fairy',    hp:330, tier:3, ability:{id:'adaptability', name:'妖精氣場', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}, attacks:[{name:'月亮力量',dmg:68,cost:10,type:'fairy',megaBoost:true,bonusEnergy:5},{name:'仙子之息',dmg:74,cost:11,type:'fairy',status:{effect:'paralysis', chance:0.2}},{name:'光之波動',dmg:74,cost:11,type:'fairy',status:{effect:'freeze', chance:0.15}},{name:'精神強擊',dmg:74,cost:11,type:'psychic',selfHeal:0.15}]},
  { id:378, name:'雷吉艾斯',   type:'ice',      hp:370, tier:3, ability:{id:'thick-fat', name:'厚脂肪', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}, attacks:[{name:'暴風雪',dmg:78,cost:13,type:'ice',status:{effect:'freeze', chance:0.2},megaBoost:true,bonusEnergy:8},{name:'閃光炮',dmg:84,cost:13,type:'steel',status:{effect:'paralysis', chance:0.2}},{name:'冰耳光',dmg:84,cost:13,type:'ice',status:{effect:'confusion', chance:0.25}},{name:'電磁砲',dmg:84,cost:13,type:'electric',status:{effect:'burn', chance:0.25}}]},
  { id:717, name:'伊裴爾塔爾', type:'dark',     type2:'flying',  hp:350, tier:3, ability:{id:'no-weakness-dodge', name:'深淵支配', trigger:'onDefend', desc:'不會受到超效傷害；10% 機率完全閃避攻擊'}, attacks:[{name:'羽棲',cost:11,type:'flying',support:true,effect:'roost'},{name:'朽滅之歌',dmg:93,cost:12,type:'flying',selfHeal:0.16},{name:'空氣斬',dmg:77,cost:12,type:'flying',status:{effect:'freeze', chance:0.15}},{name:'夜騷動',dmg:93,cost:12,type:'dark',selfHeal:0.26}]},
  { id:483, name:'帝牙盧卡',   type:'steel',    type2:'dragon',  hp:360, tier:3, ability:{id:'dragon-domain', name:'龍域降臨', trigger:'onEnter', desc:'上場時場地切換為龍之谷；龍屬性攻擊傷害額外 +40'}, attacks:[{name:'閃光炮',dmg:76,cost:12,type:'steel',megaBoost:true,bonusEnergy:7},{name:'鋼鐵翼',dmg:95,cost:10,type:'steel',selfHeal:0.19},{name:'龍爪',dmg:95,cost:10,type:'dragon',selfHeal:0.21},{name:'時間咆哮',dmg:95,cost:10,type:'dragon',selfHeal:0.2}]},
  { id:484, name:'帕路奇亞',   type:'water',    type2:'dragon',  hp:360, tier:3, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'衝浪',dmg:76,cost:12,type:'water',megaBoost:true,bonusEnergy:7},{name:'龍之脈動',dmg:82,cost:11,type:'dragon',status:{effect:'paralysis', chance:0.2}},{name:'水之脈動',dmg:82,cost:11,type:'water',selfHeal:0.25},{name:'空間扭曲',dmg:98,cost:11,type:'dragon',selfHeal:0.15}]},
  { id:727, name:'熾焰咆哮虎', type:'fire',     type2:'dark',    hp:300, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'火焰噴射',dmg:59,cost:3,type:'fire',status:{effect:'burn', chance:0.25},megaBoost:true,bonusEnergy:6},{name:'暗黑強打',dmg:95,cost:9,type:'dark',megaBoost:true,bonusEnergy:7},{name:'超強衝擊',dmg:135,cost:13,type:'fighting',status:{effect:'paralysis', chance:0.2}},{name:'赤焰衝擊',dmg:138,cost:13,type:'fire',selfHeal:0.2}]},
  // 新增：補足各屬性
  { id:128, name:'肯泰羅',     type:'normal',                    hp:240, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'橫衝直撞',dmg:62,cost:1,type:'normal',status:{effect:'confusion', chance:0.2},megaBoost:true,bonusEnergy:5},{name:'撐住',cost:5,type:'normal',support:true,effect:'brace'},{name:'地震',dmg:97,cost:7,type:'ground',megaBoost:true,bonusEnergy:5},{name:'強力碰撞',dmg:151,cost:12,type:'normal',selfHeal:0.21}]},
  { id:295, name:'爆音怪',     type:'normal',                    hp:240, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'冥想',cost:3,type:'normal',support:true,effect:'meditate'},{name:'噴火',dmg:98,cost:6,type:'fire',status:{effect:'burn', chance:0.2},megaBoost:true,bonusEnergy:4},{name:'衝浪',dmg:96,cost:6,type:'water',megaBoost:true,bonusEnergy:4},{name:'破壞光線',dmg:144,cost:11,type:'normal',status:{effect:'paralysis', chance:0.2}}]},
  { mega:{spriteId:10065, type:'grass', type2:'dragon', ability:{id:'motor-drive', name:'避雷針', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:254, name:'蜥蜴王',     type:'grass',                     hp:260, tier:2, ability:{id:'blaze-boost', name:'茂盛', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'電球',dmg:59,cost:2,type:'electric',status:{effect:'paralysis', chance:0.15},megaBoost:true,bonusEnergy:6},{name:'能量球',dmg:91,cost:8,type:'grass',status:{effect:'confusion', chance:0.15},megaBoost:true,bonusEnergy:6},{name:'大地之力',dmg:89,cost:7,type:'ground',megaBoost:true,bonusEnergy:5},{name:'冥想',cost:3,type:'grass',support:true,effect:'meditate'}]},
  { id:24,  name:'阿柏怪',     type:'poison',                    hp:200, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'纏繞',dmg:66,cost:0,type:'normal',status:{effect:'sleep', chance:0.25},megaBoost:true,bonusEnergy:4},{name:'毒牙',dmg:64,cost:0,type:'poison',status:{effect:'poison', chance:0.35},megaBoost:true,bonusEnergy:4},{name:'甩尾',dmg:96,cost:6,type:'normal',megaBoost:true,bonusEnergy:4},{name:'撐住',cost:5,type:'poison',support:true,effect:'brace'}]},
  { id:73,  name:'毒刺水母',   type:'water',    type2:'poison',  hp:220, tier:1, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'集氣',cost:3,type:'water',support:true,effect:'focus-energy',bonusEnergy:9},{name:'毒液',dmg:74,cost:4,type:'poison',status:{effect:'poison', chance:0.3},megaBoost:true,bonusEnergy:7},{name:'衝浪',dmg:120,cost:9,type:'water',megaBoost:true,bonusEnergy:7},{name:'水砲',dmg:170,cost:14,type:'water',status:{effect:'burn', chance:0.25}}]},
  { id:454, name:'毒骷蛙',     type:'fighting', type2:'poison',  hp:230, tier:1, ability:{id:'water-absorb', name:'乾燥皮膚', trigger:'onDefend', desc:'受到水屬性攻擊時完全免疫，並回復最大HP的1/4'}, attacks:[{name:'毒粉',cost:1,type:'fighting',support:true,effect:'debuff',status:{effect:'poison', chance: 1}},{name:'突擊',dmg:83,cost:4,type:'dark',megaBoost:true,bonusEnergy:7},{name:'十字劈',dmg:125,cost:9,type:'fighting',megaBoost:true,bonusEnergy:7},{name:'近身戰',dmg:179,cost:14,type:'fighting',selfHeal:0.27}]},
  { id:553, name:'流氓鱷',     type:'ground',   type2:'dark',    hp:270, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'岩石滑落',dmg:69,cost:4,type:'rock',status:{effect:'paralysis', chance:0.15},megaBoost:true,bonusEnergy:7},{name:'集氣',cost:3,type:'ground',support:true,effect:'focus-energy',bonusEnergy:9},{name:'地震',dmg:102,cost:9,type:'ground',megaBoost:true,bonusEnergy:7},{name:'夜斬',dmg:147,cost:14,type:'dark',selfHeal:0.24}]},
  { id:641, name:'龍捲雲',     type:'flying',                    hp:290, tier:2, ability:{id:'item-synergy', name:'機械之心', trigger:'onAttack', desc:'本回合使用過道具卡時，攻擊傷害 +40'}, attacks:[{name:'空氣斬',dmg:50,cost:1,type:'flying',status:{effect:'confusion', chance:0.2},megaBoost:true,bonusEnergy:5},{name:'雷電',dmg:86,cost:8,type:'electric',status:{effect:'paralysis', chance:0.2},megaBoost:true,bonusEnergy:6},{name:'颶風',dmg:128,cost:12,type:'flying',selfHeal:0.22},{name:'暴風',dmg:132,cost:12,type:'flying',selfHeal:0.18}]},
  { mega:{spriteId:10308, type:'fighting', type2:'flying', ability:{id:'huge-power', name:'唱反調', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:398, name:'姆克鷹',     type:'normal',   type2:'flying',  hp:240, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'燕返',dmg:65,cost:0,type:'normal',megaBoost:true,bonusEnergy:4},{name:'衝撞',dmg:97,cost:6,type:'normal',megaBoost:true,bonusEnergy:4},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'},{name:'勇鳥猛衝',dmg:148,cost:12,type:'flying',selfHeal:0.25}]},
  { id:663, name:'烈箭鷹',     type:'fire',     type2:'flying',  hp:260, tier:2, ability:{id:'flame-body', name:'火焰之軀', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入燒傷'}, attacks:[{name:'炎翼衝刺',dmg:57,cost:3,type:'fire',status:{effect:'burn', chance:0.2},megaBoost:true,bonusEnergy:6},{name:'空氣斬',dmg:95,cost:9,type:'flying',status:{effect:'confusion', chance:0.2},megaBoost:true,bonusEnergy:7},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'},{name:'勇鳥猛衝',dmg:139,cost:14,type:'flying',selfHeal:0.2}]},
  { mega:{spriteId:10047, type:'bug', type2:'fighting', ability:{id:'huge-power', name:'連續攻擊', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:214, name:'赫拉克羅斯', type:'bug',      type2:'fighting',hp:270, tier:2, ability:{id:'guts', name:'毅力', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'電磁波',cost:1,type:'bug',support:true,effect:'debuff',status:{effect:'paralysis', chance:1}},{name:'地震',dmg:98,cost:10,type:'ground',megaBoost:true,bonusEnergy:8},{name:'聖甲蟲衝擊',dmg:102,cost:9,type:'bug',megaBoost:true,bonusEnergy:7},{name:'近身戰',dmg:143,cost:14,type:'fighting',status:{effect:'sleep', chance:0.2}}]},
  { mega:{spriteId:10046, type:'bug', type2:'steel', ability:{id:'technician', name:'技術高手', trigger:'onAttack', desc:'威力 60 以下的招式，傷害 ×1.1'}}, id:212, name:'巨鉗螳螂',   type:'bug',      type2:'steel',   hp:260, tier:2, ability:{id:'blaze-boost', name:'蟲之預感', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'影舞',cost:2,type:'bug',support:true,effect:'shadow-dance'},{name:'子彈拳',dmg:89,cost:8,type:'steel',megaBoost:true,bonusEnergy:6},{name:'蟲刃剪',dmg:89,cost:7,type:'bug',megaBoost:true,bonusEnergy:5},{name:'鐵頭功',dmg:130,cost:12,type:'steel',selfHeal:0.23}]},
  { id:469, name:'遠古巨蜓',   type:'bug',      type2:'flying',  hp:230, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'空氣斬',dmg:78,cost:4,type:'flying',status:{effect:'confusion', chance:0.2},megaBoost:true,bonusEnergy:7},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'},{name:'蟲鳴',dmg:120,cost:9,type:'bug',megaBoost:true,bonusEnergy:7},{name:'颶風',dmg:174,cost:14,type:'flying',selfHeal:0.25}]},
  { mega:{spriteId:10049, type:'rock', type2:'dark', ability:{id:'solid-rock', name:'揚沙', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:248, name:'班基拉斯',   type:'rock',     type2:'dark',    hp:300, tier:2, ability:{id:'solid-rock', name:'揚沙', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'碎岩',dmg:68,cost:5,type:'rock',status:{effect:'paralysis', chance:0.15},megaBoost:true,bonusEnergy:8},{name:'咬碎',dmg:103,cost:9,type:'dark',status:{effect:'confusion', chance:0.2},megaBoost:true,bonusEnergy:7},{name:'地震',dmg:145,cost:15,type:'ground',selfHeal:0.21},{name:'岩石炮',dmg:147,cost:14,type:'rock',status:{effect:'sleep', chance:0.2}}]},
  { mega:{spriteId:10042, type:'rock', type2:'flying', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:142, name:'化石翼龍',   type:'rock',     type2:'flying',  hp:260, tier:2, ability:{id:'no-weakness-dodge', name:'深淵支配', trigger:'onDefend', desc:'不會受到超效傷害；10% 機率完全閃避攻擊'}, attacks:[{name:'咬碎',dmg:62,cost:4,type:'dark',status:{effect:'confusion', chance:0.15},megaBoost:true,bonusEnergy:7},{name:'翼擊',dmg:99,cost:8,type:'flying',megaBoost:true,bonusEnergy:6},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'},{name:'岩石炮',dmg:140,cost:14,type:'rock',selfHeal:0.2}]},
  { id:526, name:'龐岩怪',     type:'rock',                      hp:280, tier:2, ability:{id:'rock-domain', name:'磐岩支配', trigger:'onEnter', desc:'上場時場地切換為岩石地帶；岩石屬性攻擊傷害額外 +40'}, attacks:[{name:'閃光炮',dmg:52,cost:1,type:'steel',megaBoost:true,bonusEnergy:5},{name:'冥想',cost:3,type:'rock',support:true,effect:'meditate'},{name:'地震',dmg:121,cost:12,type:'ground',status:{effect:'freeze', chance:0.15}},{name:'岩石炮',dmg:120,cost:11,type:'rock',status:{effect:'poison', chance:0.3}}]},
  { id:477, name:'黑夜魔靈',   type:'ghost',                     hp:220, tier:1, ability:{id:'shield-invert', name:'顛倒之心', trigger:'onDefend', desc:'對手的防禦加成效果對自己反而變成傷害加成'}, attacks:[{name:'暗影爪',dmg:72,cost:3,type:'ghost',status:{effect:'paralysis', chance:0.2},megaBoost:true,bonusEnergy:6},{name:'冰凍拳',dmg:72,cost:3,type:'ice',status:{effect:'freeze', chance:0.1},megaBoost:true,bonusEnergy:6},{name:'幽靈球',dmg:113,cost:8,type:'ghost',megaBoost:true,bonusEnergy:6},{name:'詭計',cost:3,type:'ghost',support:true,effect:'trick'}]},
  { mega:{spriteId:10291, type:'ghost', type2:'fire', ability:{id:'frisk-ward', name:'穿透', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:609, name:'水晶燈火靈', type:'ghost',    type2:'fire',    hp:260, tier:2, ability:{id:'flash-fire', name:'引火', trigger:'onDefend', desc:'受到火屬性攻擊時完全免疫，下次攻擊威力 +20'}, attacks:[{name:'小偷',cost:5,type:'ghost',support:true,effect:'thief'},{name:'噴火',dmg:86,cost:7,type:'fire',status:{effect:'burn', chance:0.25},megaBoost:true,bonusEnergy:5},{name:'火焰漩渦',dmg:89,cost:8,type:'fire',status:{effect:'burn', chance:0.2},megaBoost:true,bonusEnergy:6},{name:'暗影球',dmg:128,cost:12,type:'ghost',status:{effect:'confusion', chance:0.25}}]},
  { mega:{spriteId:10057, type:'dark', type2:null, ability:{id:'frisk-ward', name:'魔法鏡', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:359, name:'阿勃梭魯',   type:'dark',                      hp:220, tier:1, ability:{id:'huge-power', name:'超幸運', trigger:'onAttack', desc:'攻擊傷害固定 +40'}, attacks:[{name:'夜斬',dmg:70,cost:4,type:'dark',megaBoost:true,bonusEnergy:7},{name:'追影斬',dmg:68,cost:4,type:'dark',megaBoost:true,bonusEnergy:7},{name:'冥想',cost:3,type:'dark',support:true,effect:'meditate'},{name:'暗黑脈衝',dmg:163,cost:14,type:'dark',selfHeal:0.26}]},
  // ── +30 新增（最終進化型，非幻獸/神獸，無龍/妖精屬性）──
  { id:865, name:'蔥遊兵', type:'fighting',  hp:220, tier:1, ability:{id:'desperate-blade', name:'背水之刃', trigger:'onAttack', desc:'HP 低於 50% 時，攻擊傷害 +40'}, attacks:[{name:'連續攻擊',dmg:67,cost:3,type:'normal',megaBoost:true,bonusEnergy:6},{name:'影舞',cost:2,type:'fighting',support:true,effect:'shadow-dance'},{name:'居合斬',dmg:112,cost:8,type:'fighting',status:{effect:'paralysis', chance:0.15},megaBoost:true,bonusEnergy:6},{name:'近身戰',dmg:157,cost:13,type:'fighting',selfHeal:0.18}]},
  { id:297, name:'鐵掌力士', type:'fighting',  hp:250, tier:1, ability:{id:'fighting-domain', name:'鬥氣支配', trigger:'onEnter', desc:'上場時場地切換為羅馬鬥技場；格鬥屬性攻擊傷害額外 +40'}, attacks:[{name:'壓制',dmg:55,cost:1,type:'normal',megaBoost:true,bonusEnergy:5},{name:'近身戰',dmg:84,cost:7,type:'fighting',megaBoost:true,bonusEnergy:5},{name:'豪腕',dmg:125,cost:12,type:'fighting',selfHeal:0.22},{name:'集氣',cost:3,type:'fighting',support:true,effect:'focus-energy',bonusEnergy:9}]},
  { id:342, name:'鐵螯龍蝦', type:'water', type2:'dark', hp:210, tier:1, ability:{id:'adaptability', name:'適應力', trigger:'onAttack', desc:'本系加成（STAB）提升為 ×1.2（原本 ×1.1）'}, attacks:[{name:'冥想',cost:3,type:'water',support:true,effect:'meditate'},{name:'夜斬',dmg:70,cost:1,type:'dark',megaBoost:true,bonusEnergy:5},{name:'亂爪',dmg:104,cost:8,type:'dark',megaBoost:true,bonusEnergy:6},{name:'泥巴射擊',dmg:158,cost:13,type:'ground',status:{effect:'burn', chance:0.25}}]},
  { id:660, name:'掘地兔', type:'normal', type2:'ground', hp:230, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'砂子攻擊',dmg:79,cost:5,type:'ground',megaBoost:true,bonusEnergy:8},{name:'小偷',cost:5,type:'normal',support:true,effect:'thief'},{name:'地震',dmg:125,cost:9,type:'ground',megaBoost:true,bonusEnergy:7},{name:'岩崩',dmg:175,cost:14,type:'rock',selfHeal:0.21}]},
  { id:632, name:'鐵蟻', type:'steel', type2:'bug', hp:200, tier:1, ability:{id:'status-immune-once', name:'淬鍊之心', trigger:'onStatus', desc:'首次被施加異常狀態時解除並免疫，之後攻擊傷害永久 +40'}, attacks:[{name:'撐住',cost:5,type:'steel',support:true,effect:'brace'},{name:'金屬爪',dmg:70,cost:1,type:'steel',megaBoost:true,bonusEnergy:5},{name:'鋼鐵頭',dmg:100,cost:7,type:'steel',megaBoost:true,bonusEnergy:5},{name:'蟲之抵抗',dmg:150,cost:12,type:'bug',status:{effect:'paralysis', chance:0.2}}]},
  { id:558, name:'岩殿居蟹', type:'bug', type2:'rock', hp:240, tier:1, ability:{id:'status-immune-once', name:'淬鍊之心', trigger:'onStatus', desc:'首次被施加異常狀態時解除並免疫，之後攻擊傷害永久 +40'}, attacks:[{name:'蟲咬',dmg:64,cost:0,type:'bug',megaBoost:true,bonusEnergy:4},{name:'灼熱',cost:1,type:'bug',support:true,effect:'debuff',status:{effect:'burn', chance: 1}},{name:'岩石封鎖',dmg:102,cost:7,type:'rock',megaBoost:true,bonusEnergy:5},{name:'X 剪刀',dmg:150,cost:12,type:'bug',status:{effect:'burn', chance:0.25}}]},
  { id:105, name:'嘎啦嘎啦', type:'ground',  hp:220, tier:1, ability:{id:'guts', name:'堅韌', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'集氣',cost:3,type:'ground',support:true,effect:'focus-energy',bonusEnergy:9},{name:'喊叫',dmg:66,cost:2,type:'normal',megaBoost:true,bonusEnergy:6},{name:'地震',dmg:115,cost:8,type:'ground',megaBoost:true,bonusEnergy:6},{name:'骨棒',dmg:160,cost:14,type:'ground',selfHeal:0.25}]},
  { id:338, name:'太陽岩', type:'rock', type2:'psychic', hp:230, tier:1, ability:{id:'chance-debuff', name:'穿透', trigger:'onAttack', desc:'攻擊命中後 25% 機率讓對方下次攻擊傷害 ×0.9'}, attacks:[{name:'夜襲',dmg:77,cost:4,type:'dark',megaBoost:true,bonusEnergy:7},{name:'念力',dmg:77,cost:4,type:'psychic',megaBoost:true,bonusEnergy:7},{name:'岩石炮',dmg:125,cost:10,type:'rock',megaBoost:true,bonusEnergy:8},{name:'灼熱',cost:1,type:'rock',support:true,effect:'debuff',status:{effect:'burn', chance: 1}}]},
  { id:53, name:'貓老大', type:'normal',  hp:210, tier:1, ability:{id:'legacy-boost', name:'指揮', trigger:'onLeave', desc:'陣亡或被換下場時，下一隻上場的我方寶可夢首次攻擊：能量消耗×0.5、傷害+40'}, attacks:[{name:'冥想',cost:3,type:'normal',support:true,effect:'meditate'},{name:'音爆拳',dmg:68,cost:1,type:'fighting',megaBoost:true,bonusEnergy:5},{name:'惡意突刺',dmg:107,cost:7,type:'dark',megaBoost:true,bonusEnergy:5},{name:'連續切',dmg:154,cost:12,type:'normal',status:{effect:'confusion', chance:0.25}}]},
  { id:508, name:'長毛狗', type:'normal',  hp:240, tier:1, ability:{id:'desperate-blade', name:'背水之刃', trigger:'onAttack', desc:'HP 低於 50% 時，攻擊傷害 +40'}, attacks:[{name:'咬住',dmg:61,cost:0,type:'normal',megaBoost:true,bonusEnergy:4},{name:'吼叫',dmg:96,cost:6,type:'normal',megaBoost:true,bonusEnergy:4},{name:'詭計',cost:3,type:'normal',support:true,effect:'trick'},{name:'火焰牙',dmg:98,cost:7,type:'fire',status:{effect:'burn', chance:0.15},megaBoost:true,bonusEnergy:5}]},
  { id:134, name:'水伊布', type:'water',  hp:260, tier:1, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'水槍',dmg:54,cost:3,type:'water',megaBoost:true,bonusEnergy:6},{name:'迴旋踢',dmg:95,cost:8,type:'fighting',megaBoost:true,bonusEnergy:6},{name:'撐住',cost:5,type:'water',support:true,effect:'brace'},{name:'冰凍光束',dmg:97,cost:9,type:'ice',status:{effect:'freeze', chance:0.15},megaBoost:true,bonusEnergy:7}]},
  { mega:{spriteId:10090, type:'bug', type2:'poison', ability:{id:'adaptability', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:15, name:'大針蜂', type:'bug', type2:'poison', hp:200, tier:1, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'針刺',dmg:60,cost:1,type:'bug',megaBoost:true,bonusEnergy:5},{name:'毒針',dmg:68,cost:1,type:'poison',megaBoost:true,bonusEnergy:5},{name:'十字剪',dmg:103,cost:7,type:'bug',megaBoost:true,bonusEnergy:5},{name:'撐住',cost:5,type:'bug',support:true,effect:'brace'}]},
  { id:411, name:'護城龍', type:'rock', type2:'steel', hp:220, tier:1, ability:{id:'retaliate-boost', name:'反骨', trigger:'onDefend', desc:'受到攻擊後，下次攻擊傷害 ×1.1'}, attacks:[{name:'金屬音',dmg:67,cost:3,type:'steel',megaBoost:true,bonusEnergy:6},{name:'頭槌',dmg:68,cost:2,type:'normal',megaBoost:true,bonusEnergy:6},{name:'岩崩',dmg:108,cost:8,type:'rock',megaBoost:true,bonusEnergy:6},{name:'撐住',cost:5,type:'rock',support:true,effect:'brace'}]},
  { mega:{spriteId:10064, type:'water', type2:'ground', ability:{id:'huge-power', name:'飛毛腿', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:260, name:'巨沼怪', type:'water', type2:'ground', hp:300, tier:2, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'水槍',dmg:59,cost:3,type:'water',megaBoost:true,bonusEnergy:6},{name:'泥巴射擊',dmg:92,cost:8,type:'ground',megaBoost:true,bonusEnergy:6},{name:'地震',dmg:136,cost:13,type:'ground',status:{effect:'confusion', chance:0.25}},{name:'冰凍拳',dmg:135,cost:13,type:'ice',status:{effect:'confusion', chance:0.25}}]},
  { id:407, name:'羅絲雷朵', type:'grass', type2:'poison', hp:270, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'劍舞',cost:4,type:'grass',support:true,effect:'sword-dance'},{name:'魔法葉',dmg:99,cost:9,type:'grass',megaBoost:true,bonusEnergy:7},{name:'花瓣舞',dmg:99,cost:9,type:'grass',megaBoost:true,bonusEnergy:7},{name:'污泥炸彈',dmg:141,cost:14,type:'poison',status:{effect:'burn', chance:0.25}}]},
  { id:724, name:'狙射樹梟', type:'grass', type2:'ghost', hp:290, tier:2, ability:{id:'item-synergy', name:'機械之心', trigger:'onAttack', desc:'本回合使用過道具卡時，攻擊傷害 +40'}, attacks:[{name:'飛葉快刀',dmg:50,cost:1,type:'grass',megaBoost:true,bonusEnergy:5},{name:'影子偷襲',dmg:90,cost:8,type:'ghost',megaBoost:true,bonusEnergy:6},{name:'幽靈箭',dmg:133,cost:12,type:'ghost',status:{effect:'burn', chance:0.25}},{name:'光合作用強擊',dmg:128,cost:13,type:'grass',selfHeal:0.25}]},
  { id:452, name:'龍王蠍', type:'poison', type2:'dark', hp:280, tier:2, ability:{id:'poison-domain', name:'劇毒支配', trigger:'onEnter', desc:'上場時場地切換為劇毒領域；毒屬性攻擊傷害額外 +40'}, attacks:[{name:'毒針',dmg:54,cost:0,type:'poison',status:{effect:'poison', chance:0.3},megaBoost:true,bonusEnergy:4},{name:'夜斬',dmg:80,cost:6,type:'dark',megaBoost:true,bonusEnergy:4},{name:'撐住',cost:5,type:'poison',support:true,effect:'brace'},{name:'惡意突刺',dmg:120,cost:11,type:'dark',status:{effect:'sleep', chance:0.2}}]},
  { id:862, name:'堵攔熊', type:'dark', type2:'normal', hp:300, tier:2, ability:{id:'guts', name:'堅韌', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'夜斬',dmg:62,cost:4,type:'dark',megaBoost:true,bonusEnergy:7},{name:'連續切',dmg:98,cost:8,type:'normal',megaBoost:true,bonusEnergy:6},{name:'惡意突刺',dmg:141,cost:14,type:'dark',status:{effect:'confusion', chance:0.25}},{name:'蠻力',dmg:142,cost:14,type:'normal',selfHeal:0.2}]},
  { id:738, name:'鍬農炮蟲', type:'bug', type2:'electric', hp:270, tier:2, ability:{id:'desperate-blade', name:'背水之刃', trigger:'onAttack', desc:'HP 低於 50% 時，攻擊傷害 +40'}, attacks:[{name:'蟲咬',dmg:64,cost:4,type:'bug',megaBoost:true,bonusEnergy:7},{name:'電擊',dmg:99,cost:10,type:'electric',megaBoost:true,bonusEnergy:8},{name:'蟲鳴',dmg:96,cost:9,type:'bug',megaBoost:true,bonusEnergy:7},{name:'撐住',cost:5,type:'bug',support:true,effect:'brace'}]},
  { mega:{spriteId:10313, type:'ground', type2:'ghost', ability:{id:'tough-claws', name:'隱形拳', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:623, name:'泥偶巨人', type:'ground', type2:'ghost', hp:310, tier:2, ability:{id:'retaliate-boost', name:'反骨', trigger:'onDefend', desc:'受到攻擊後，下次攻擊傷害 ×1.1'}, attacks:[{name:'泥巴射擊',dmg:68,cost:5,type:'ground',megaBoost:true,bonusEnergy:8},{name:'影子偷襲',dmg:105,cost:10,type:'ghost',megaBoost:true,bonusEnergy:8},{name:'地震',dmg:150,cost:15,type:'ground',selfHeal:0.22},{name:'惡靈波動',dmg:146,cost:15,type:'ghost',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10280, type:'water', type2:'psychic', ability:{id:'huge-power', name:'大力士', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:121, name:'寶石海星', type:'water', type2:'psychic', hp:270, tier:2, ability:{id:'frisk-ward', name:'神秘之守', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'水槍',dmg:70,cost:5,type:'water',megaBoost:true,bonusEnergy:8},{name:'念力',dmg:104,cost:10,type:'psychic',megaBoost:true,bonusEnergy:8},{name:'集氣',cost:3,type:'water',support:true,effect:'focus-energy',bonusEnergy:9},{name:'精神強擊',dmg:150,cost:15,type:'psychic',selfHeal:0.15}]},
  { mega:{spriteId:10045, type:'electric', type2:'dragon', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對方的防禦型特性'}}, id:181, name:'電龍', type:'electric',  hp:300, tier:2, ability:{id:'static', name:'靜電', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入麻痺'}, attacks:[{name:'電擊',dmg:55,cost:2,type:'electric',megaBoost:true,bonusEnergy:6},{name:'電光一閃',dmg:90,cost:8,type:'normal',megaBoost:true,bonusEnergy:6},{name:'十萬伏特',dmg:134,cost:13,type:'electric',status:{effect:'freeze', chance:0.15}},{name:'雷電',dmg:138,cost:13,type:'electric',status:{effect:'confusion', chance:0.25}}]},
  { mega:{spriteId:10316, type:'bug', type2:'steel', ability:{id:'solid-rock', name:'重甲化', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:768, name:'具甲武者', type:'bug', type2:'water', hp:290, tier:2, ability:{id:'retaliate-boost', name:'反骨', trigger:'onDefend', desc:'受到攻擊後，下次攻擊傷害 ×1.1'}, attacks:[{name:'水流手裏劍',dmg:51,cost:2,type:'water',megaBoost:true,bonusEnergy:6},{name:'蟲咬',dmg:88,cost:7,type:'bug',megaBoost:true,bonusEnergy:5},{name:'X 剪刀',dmg:128,cost:13,type:'bug',selfHeal:0.17},{name:'水炮',dmg:131,cost:13,type:'water',status:{effect:'paralysis', chance:0.2}}]},
  { id:465, name:'巨蔓藤', type:'grass',  hp:310, tier:2, ability:{id:'grass-domain', name:'密林支配', trigger:'onEnter', desc:'上場時場地切換為邪惡森林；草屬性攻擊傷害額外 +40'}, attacks:[{name:'魔法葉',dmg:68,cost:4,type:'grass',megaBoost:true,bonusEnergy:7},{name:'藤鞭',dmg:100,cost:10,type:'grass',megaBoost:true,bonusEnergy:8},{name:'實力全開',dmg:149,cost:15,type:'normal',status:{effect:'confusion', chance:0.25}},{name:'能量球',dmg:144,cost:15,type:'grass',status:{effect:'poison', chance:0.3}}]},
  { id:713, name:'冰岩怪', type:'ice',  hp:320, tier:2, ability:{id:'no-weakness-dodge', name:'深淵支配', trigger:'onDefend', desc:'不會受到超效傷害；10% 機率完全閃避攻擊'}, attacks:[{name:'冰凍拳',dmg:85,cost:6,type:'ice',status:{effect:'freeze', chance:0.15},megaBoost:true,bonusEnergy:4},{name:'碎岩',dmg:122,cost:11,type:'rock',selfHeal:0.24},{name:'暴風雪',dmg:126,cost:11,type:'ice',status:{effect:'poison', chance:0.3}},{name:'雪崩',dmg:122,cost:11,type:'ice',selfHeal:0.17}]},
  { id:576, name:'哥德小姐', type:'psychic',  hp:280, tier:2, ability:{id:'chance-debuff', name:'穿透', trigger:'onAttack', desc:'攻擊命中後 25% 機率讓對方下次攻擊傷害 ×0.9'}, attacks:[{name:'念力',dmg:58,cost:1,type:'psychic',megaBoost:true,bonusEnergy:5},{name:'擾亂精神',cost:1,type:'psychic',support:true,effect:'debuff',status:{effect:'confusion', chance:1}},{name:'精神強擊',dmg:124,cost:11,type:'psychic',selfHeal:0.2},{name:'未來預知',dmg:129,cost:12,type:'psychic',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10048, type:'dark', type2:'fire', ability:{id:'blaze-boost', name:'太陽之力', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:229, name:'黑魯加', type:'fire', type2:'dark', hp:280, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'夜斬',dmg:59,cost:1,type:'dark',megaBoost:true,bonusEnergy:5},{name:'火焰牙',dmg:85,cost:7,type:'fire',status:{effect:'burn', chance:0.2},megaBoost:true,bonusEnergy:5},{name:'惡意突刺',dmg:125,cost:12,type:'dark',selfHeal:0.26},{name:'詭計',cost:3,type:'fire',support:true,effect:'trick'}]},
  { id:464, name:'超甲狂犀', type:'ground', type2:'rock', hp:360, tier:3, ability:{id:'ground-domain', name:'風沙支配', trigger:'onEnter', desc:'上場時場地切換為沙塵暴；地面屬性攻擊傷害額外 +40'}, attacks:[{name:'角撞',dmg:75,cost:13,type:'normal',megaBoost:true,bonusEnergy:8},{name:'泥巴射擊',dmg:86,cost:11,type:'ground',selfHeal:0.18},{name:'岩崩',dmg:86,cost:11,type:'rock',status:{effect:'confusion', chance:0.25}},{name:'地震',dmg:86,cost:11,type:'ground',status:{effect:'poison', chance:0.3}}]},
  { id:473, name:'象牙豬', type:'ice', type2:'ground', hp:350, tier:3, ability:{id:'weaken-buffs', name:'威壓氣場', trigger:'onDefend', desc:'對手的攻擊力提升效果減半'}, attacks:[{name:'冰凍拳',dmg:72,cost:11,type:'ice',status:{effect:'freeze', chance:0.15},megaBoost:true,bonusEnergy:6},{name:'地震',dmg:81,cost:12,type:'ground',selfHeal:0.28},{name:'雪崩',dmg:81,cost:12,type:'ice',selfHeal:0.25},{name:'冰牙',dmg:81,cost:12,type:'ice',status:{effect:'poison', chance:0.3}}]},
  { id:625, name:'劈斬司令', type:'dark', type2:'steel', hp:330, tier:3, ability:{id:'guts', name:'堅韌', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'金屬爪',dmg:64,cost:10,type:'steel',megaBoost:true,bonusEnergy:5},{name:'夜斬',dmg:73,cost:12,type:'dark',selfHeal:0.16},{name:'惡意突刺',dmg:73,cost:8,type:'dark',selfHeal:0.23},{name:'鐵頭功',dmg:73,cost:8,type:'steel',selfHeal:0.3}]},
  /* ── Mega 進化擴充（Legends Z-A / 原有 46 種缺漏補完） ── */
  { mega:{spriteId:10073, type:'normal', type2:'flying', ability:{id:'huge-power', name:'無防守', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:18, name:'大比鳥', type:'normal', type2:'flying', hp:220, tier:1, ability:{id:'frisk-ward', name:'牽制', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'啄',dmg:61,cost:2,type:'flying',megaBoost:true,bonusEnergy:6},{name:'疾風拳',dmg:62,cost:2,type:'normal',megaBoost:true,bonusEnergy:6},{name:'燕返',dmg:109,cost:8,type:'flying',megaBoost:true,bonusEnergy:6},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'}]},
  { mega:{spriteId:10039, type:'normal', type2:null, ability:{id:'huge-power', name:'親子羈絆', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:115, name:'袋獸', type:'normal', hp:280, tier:2, ability:{id:'status-immune-once', name:'淬鍊之心', trigger:'onStatus', desc:'首次被施加異常狀態時解除並免疫，之後攻擊傷害永久 +40'}, attacks:[{name:'扒',dmg:55,cost:2,type:'normal',megaBoost:true,bonusEnergy:6},{name:'連環巴掌',dmg:85,cost:7,type:'normal',megaBoost:true,bonusEnergy:5},{name:'撐住',cost:5,type:'normal',support:true,effect:'brace'},{name:'地震',dmg:126,cost:12,type:'ground',status:{effect:'sleep', chance:0.2}}]},
  { mega:{spriteId:10040, type:'bug', type2:'flying', ability:{id:'adaptability', name:'飛行皮膚', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:127, name:'凱羅斯', type:'bug', hp:210, tier:1, ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對方的防禦型特性'}, attacks:[{name:'斷頭台',dmg:60,cost:1,type:'bug',megaBoost:true,bonusEnergy:5},{name:'劍舞',cost:4,type:'bug',support:true,effect:'sword-dance'},{name:'角撞',dmg:107,cost:7,type:'normal',megaBoost:true,bonusEnergy:5},{name:'石頭砸落',dmg:158,cost:13,type:'rock',status:{effect:'confusion', chance:0.25}}]},
  { mega:{spriteId:10072, type:'steel', type2:'ground', ability:{id:'blaze-boost', name:'沙之力', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:208, name:'大鋼蛇', type:'steel', type2:'ground', hp:290, tier:2, ability:{id:'item-synergy', name:'機械之心', trigger:'onAttack', desc:'本回合使用過道具卡時，攻擊傷害 +40'}, attacks:[{name:'綁緊',dmg:56,cost:2,type:'normal',megaBoost:true,bonusEnergy:6},{name:'鐵尾',dmg:93,cost:8,type:'steel',megaBoost:true,bonusEnergy:6},{name:'地震',dmg:131,cost:13,type:'ground',selfHeal:0.17},{name:'重磅衝撞',dmg:136,cost:13,type:'steel',selfHeal:0.2}]},
  { mega:{spriteId:10050, type:'fire', type2:'fighting', ability:{id:'huge-power', name:'加速', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:257, name:'火焰雞', type:'fire', type2:'fighting', hp:260, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'踢腿',dmg:59,cost:4,type:'fighting',megaBoost:true,bonusEnergy:7},{name:'火花',dmg:95,cost:9,type:'fire',megaBoost:true,bonusEnergy:7},{name:'烈焰衝浪腳',dmg:98,cost:9,type:'fire',megaBoost:true,bonusEnergy:7},{name:'小偷',cost:5,type:'fire',support:true,effect:'thief'}]},
  { mega:{spriteId:10066, type:'dark', type2:'ghost', ability:{id:'frisk-ward', name:'魔法鏡', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:302, name:'勾魂眼', type:'dark', type2:'ghost', hp:200, tier:1, ability:{id:'shield-invert', name:'顛倒之心', trigger:'onDefend', desc:'對手的防禦加成效果對自己反而變成傷害加成'}, attacks:[{name:'暗影球',dmg:70,cost:1,type:'ghost',megaBoost:true,bonusEnergy:5},{name:'小偷',cost:5,type:'dark',support:true,effect:'thief'},{name:'寶石爆破',dmg:101,cost:7,type:'rock',megaBoost:true,bonusEnergy:5},{name:'暗黑爆破',dmg:149,cost:12,type:'dark',selfHeal:0.25}]},
  { mega:{spriteId:10052, type:'steel', type2:'fairy', ability:{id:'huge-power', name:'大力士', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:303, name:'大嘴娃', type:'steel', type2:'fairy', hp:200, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'啃咬',dmg:61,cost:0,type:'dark',megaBoost:true,bonusEnergy:4},{name:'鐵頭',dmg:65,cost:0,type:'steel',megaBoost:true,bonusEnergy:4},{name:'詭計',cost:3,type:'steel',support:true,effect:'trick'},{name:'重磅衝撞',dmg:145,cost:11,type:'steel',status:{effect:'poison', chance:0.3}}]},
  { mega:{spriteId:10053, type:'steel', type2:null, ability:{id:'solid-rock', name:'過濾', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:306, name:'波士可多拉', type:'steel', type2:'rock', hp:310, tier:2, ability:{id:'sturdy', name:'結實', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}, attacks:[{name:'金屬爪',dmg:67,cost:5,type:'steel',megaBoost:true,bonusEnergy:8},{name:'岩石滑落',dmg:105,cost:10,type:'rock',megaBoost:true,bonusEnergy:8},{name:'重磅衝撞',dmg:146,cost:15,type:'steel',selfHeal:0.18},{name:'劈斬',dmg:146,cost:15,type:'steel',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10054, type:'fighting', type2:'psychic', ability:{id:'huge-power', name:'驚人怪力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:308, name:'恰雷姆', type:'fighting', type2:'psychic', hp:210, tier:1, ability:{id:'huge-power', name:'驚人怪力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}, attacks:[{name:'空手劈',dmg:67,cost:1,type:'fighting',megaBoost:true,bonusEnergy:5},{name:'念力',dmg:71,cost:1,type:'psychic',megaBoost:true,bonusEnergy:5},{name:'小偷',cost:5,type:'fighting',support:true,effect:'thief'},{name:'惡意彈珠',dmg:151,cost:12,type:'dark',selfHeal:0.3}]},
  { mega:{spriteId:10055, type:'electric', type2:null, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}}, id:310, name:'雷電獸', type:'electric', hp:230, tier:1, ability:{id:'static', name:'靜電', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入麻痺'}, attacks:[{name:'電擊',dmg:84,cost:5,type:'electric',megaBoost:true,bonusEnergy:8},{name:'集氣',cost:3,type:'electric',support:true,effect:'focus-energy',bonusEnergy:9},{name:'十萬伏特',dmg:124,cost:10,type:'electric',megaBoost:true,bonusEnergy:8},{name:'火焰牙',dmg:176,cost:15,type:'fire',selfHeal:0.26}]},
  { mega:{spriteId:10070, type:'water', type2:'dark', ability:{id:'tough-claws', name:'強壯之顎', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:319, name:'巨牙鯊', type:'water', type2:'dark', hp:220, tier:1, ability:{id:'rough-skin', name:'粗糙皮膚', trigger:'onDefend', desc:'受到攻擊傷害時，反彈攻擊者 1/8 最大HP 傷害'}, attacks:[{name:'水槍',dmg:78,cost:4,type:'water',megaBoost:true,bonusEnergy:7},{name:'小偷',cost:5,type:'water',support:true,effect:'thief'},{name:'衝浪',dmg:122,cost:10,type:'water',megaBoost:true,bonusEnergy:8},{name:'冰牙',dmg:176,cost:14,type:'ice',selfHeal:0.18}]},
  { mega:{spriteId:10087, type:'fire', type2:'ground', ability:{id:'tough-claws', name:'強行', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:323, name:'噴火駝', type:'fire', type2:'ground', hp:260, tier:2, ability:{id:'solid-rock', name:'硬岩', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'火花',dmg:59,cost:3,type:'fire',megaBoost:true,bonusEnergy:6},{name:'泥巴射擊',dmg:97,cost:8,type:'ground',megaBoost:true,bonusEnergy:6},{name:'集氣',cost:3,type:'fire',support:true,effect:'focus-energy',bonusEnergy:9},{name:'地震',dmg:139,cost:13,type:'ground',status:{effect:'sleep', chance:0.2}}]},
  { mega:{spriteId:10067, type:'dragon', type2:'fairy', ability:{id:'adaptability', name:'妖精皮膚', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:334, name:'七夕青鳥', type:'dragon', type2:'flying', hp:270, tier:2, ability:{id:'frisk-ward', name:'自然回復', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'啄',dmg:66,cost:4,type:'flying',megaBoost:true,bonusEnergy:7},{name:'龍之氣息',dmg:101,cost:10,type:'dragon',megaBoost:true,bonusEnergy:8},{name:'空氣斬',dmg:104,cost:9,type:'flying',megaBoost:true,bonusEnergy:7},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'}]},
  { mega:{spriteId:10056, type:'ghost', type2:null, ability:{id:'frisk-ward', name:'惡作劇之心', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:354, name:'詛咒娃娃', type:'ghost', hp:210, tier:1, ability:{id:'shield-invert', name:'顛倒之心', trigger:'onDefend', desc:'對手的防禦加成效果對自己反而變成傷害加成'}, attacks:[{name:'暗影球',dmg:71,cost:1,type:'ghost',megaBoost:true,bonusEnergy:5},{name:'集氣',cost:3,type:'ghost',support:true,effect:'focus-energy',bonusEnergy:9},{name:'暗黑爆破',dmg:106,cost:7,type:'dark',megaBoost:true,bonusEnergy:5},{name:'念力',dmg:149,cost:12,type:'psychic',selfHeal:0.19}]},
  { mega:{spriteId:10074, type:'ice', type2:null, ability:{id:'adaptability', name:'冰肌', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:362, name:'冰鬼護', type:'ice', hp:260, tier:2, ability:{id:'thick-fat', name:'冰凍之軀', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}, attacks:[{name:'冰霜拳',dmg:52,cost:3,type:'ice',megaBoost:true,bonusEnergy:6},{name:'影舞',cost:2,type:'ice',support:true,effect:'shadow-dance'},{name:'冰凍光束',dmg:90,cost:8,type:'ice',megaBoost:true,bonusEnergy:6},{name:'雪崩',dmg:136,cost:13,type:'ice',selfHeal:0.2}]},
  { mega:{spriteId:10089, type:'dragon', type2:'flying', ability:{id:'adaptability', name:'飛行皮膚', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:373, name:'暴飛龍', type:'dragon', type2:'flying', hp:340, tier:3, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'咬碎',dmg:71,cost:11,type:'dark',megaBoost:true,bonusEnergy:6},{name:'龍息',dmg:85,cost:12,type:'dragon',selfHeal:0.27},{name:'逆鱗',dmg:85,cost:12,type:'dragon',status:{effect:'freeze', chance:0.15}},{name:'暴風',dmg:85,cost:12,type:'flying',status:{effect:'confusion', chance:0.25}}]},
  { mega:{spriteId:10062, type:'dragon', type2:'psychic', ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:380, name:'拉帝亞斯', type:'dragon', type2:'psychic', hp:320, tier:3, ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'念力',dmg:83,cost:6,type:'psychic',megaBoost:true,bonusEnergy:4},{name:'龍之氣息',dmg:122,cost:12,type:'dragon',status:{effect:'sleep', chance:0.2}},{name:'魔法閃耀',dmg:128,cost:12,type:'fairy',status:{effect:'freeze', chance:0.15}},{name:'龍之波動',dmg:127,cost:12,type:'dragon',status:{effect:'burn', chance:0.25}}]},
  { mega:{spriteId:10063, type:'dragon', type2:'psychic', ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:381, name:'拉帝歐斯', type:'dragon', type2:'psychic', hp:320, tier:3, ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'龍息',dmg:80,cost:6,type:'dragon',megaBoost:true,bonusEnergy:4},{name:'念力',dmg:123,cost:11,type:'psychic',status:{effect:'burn', chance:0.25}},{name:'龍爪',dmg:122,cost:11,type:'dragon',selfHeal:0.23},{name:'未來預知',dmg:121,cost:11,type:'psychic',selfHeal:0.16}]},
  { mega:{spriteId:10088, type:'normal', type2:'fighting', ability:{id:'huge-power', name:'根性', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:428, name:'長耳兔', type:'normal', hp:220, tier:1, ability:{id:'frisk-ward', name:'魅力', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'連續拳',dmg:67,cost:2,type:'normal',megaBoost:true,bonusEnergy:6},{name:'高速星星拳',dmg:64,cost:2,type:'normal',megaBoost:true,bonusEnergy:6},{name:'高速旋轉踢',dmg:114,cost:8,type:'fighting',megaBoost:true,bonusEnergy:6},{name:'電磁波',cost:1,type:'normal',support:true,effect:'debuff',status:{effect:'paralysis', chance: 1}}]},
  { mega:{spriteId:10060, type:'grass', type2:'ice', ability:{id:'solid-rock', name:'降雪', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:460, name:'暴雪王', type:'grass', type2:'ice', hp:280, tier:2, ability:{id:'solid-rock', name:'降雪', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'冰霜拳',dmg:52,cost:1,type:'ice',megaBoost:true,bonusEnergy:5},{name:'魔法葉',dmg:80,cost:6,type:'grass',megaBoost:true,bonusEnergy:4},{name:'暴風雪',dmg:120,cost:11,type:'ice',status:{effect:'poison', chance:0.3}},{name:'劍舞',cost:4,type:'grass',support:true,effect:'sword-dance'}]},
  { mega:{spriteId:10068, type:'psychic', type2:'fighting', ability:{id:'huge-power', name:'精神力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:475, name:'艾路雷朵', type:'psychic', type2:'fighting', hp:260, tier:2, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'空手劈',dmg:51,cost:3,type:'fighting',megaBoost:true,bonusEnergy:6},{name:'念力',dmg:89,cost:8,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'影舞',cost:2,type:'psychic',support:true,effect:'shadow-dance'},{name:'近身戰',dmg:133,cost:13,type:'fighting',status:{effect:'paralysis', chance:0.2}}]},
  { mega:{spriteId:10069, type:'normal', type2:'fairy', ability:{id:'thick-fat', name:'治癒之心', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}}, id:531, name:'差不多娃娃', type:'normal', hp:300, tier:2, ability:{id:'thick-fat', name:'回復力', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}, attacks:[{name:'拍打',dmg:58,cost:2,type:'normal',megaBoost:true,bonusEnergy:6},{name:'音爆拳',dmg:94,cost:8,type:'normal',megaBoost:true,bonusEnergy:6},{name:'高周波音',dmg:139,cost:13,type:'normal',selfHeal:0.28},{name:'日光束',dmg:133,cost:13,type:'grass',selfHeal:0.29}]},
  { mega:{spriteId:10075, type:'rock', type2:'fairy', ability:{id:'frisk-ward', name:'魔法鏡', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:719, name:'蒂安希', type:'rock', type2:'fairy', hp:300, tier:3, ability:{id:'solid-rock', name:'恆淨之軀', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'岩石滑落',dmg:62,cost:4,type:'rock',megaBoost:true,bonusEnergy:7},{name:'魔法閃耀',dmg:101,cost:9,type:'fairy',megaBoost:true,bonusEnergy:7},{name:'石刃',dmg:141,cost:14,type:'rock',status:{effect:'sleep', chance:0.2}},{name:'月亮之力',dmg:142,cost:14,type:'fairy',selfHeal:0.21}]},
  { mega:{spriteId:10278, type:'fairy', type2:'flying', ability:{id:'frisk-ward', name:'魔法鏡', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:36, name:'皮可西', type:'fairy', hp:280, tier:2, ability:{id:'magic-guard', name:'魔法防守', trigger:'onStatus', desc:'不會受到中毒／燒傷的傷害'}, attacks:[{name:'拍打',dmg:56,cost:1,type:'normal',megaBoost:true,bonusEnergy:5},{name:'影舞',cost:2,type:'fairy',support:true,effect:'shadow-dance'},{name:'高周波音',dmg:127,cost:11,type:'normal',selfHeal:0.2},{name:'月亮之力',dmg:127,cost:12,type:'fairy',status:{effect:'poison', chance:0.3}}]},
  { mega:{spriteId:10279, type:'grass', type2:'poison', ability:{id:'tough-claws', name:'揭露之貌', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:71, name:'大食花', type:'grass', type2:'poison', hp:230, tier:1, ability:{id:'blaze-boost', name:'葉綠素', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'劍舞',cost:4,type:'grass',support:true,effect:'sword-dance'},{name:'毒液',dmg:82,cost:4,type:'poison',megaBoost:true,bonusEnergy:7},{name:'葉刃',dmg:125,cost:9,type:'grass',megaBoost:true,bonusEnergy:7},{name:'污泥炸彈',dmg:178,cost:15,type:'poison',status:{effect:'sleep', chance:0.2}}]},
  { mega:{spriteId:10284, type:'steel', type2:'flying', ability:{id:'solid-rock', name:'頑強', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:227, name:'盔甲鳥', type:'steel', type2:'flying', hp:270, tier:2, ability:{id:'sturdy', name:'頑強', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}, attacks:[{name:'啄',dmg:69,cost:5,type:'flying',megaBoost:true,bonusEnergy:8},{name:'鐵頭',dmg:105,cost:10,type:'steel',megaBoost:true,bonusEnergy:8},{name:'猛禽炸彈',dmg:105,cost:10,type:'flying',megaBoost:true,bonusEnergy:8},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'}]},
  { mega:{spriteId:10306, type:'psychic', type2:'steel', ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:358, name:'風鈴鈴', type:'psychic', hp:220, tier:1, ability:{id:'chance-debuff', name:'穿透', trigger:'onAttack', desc:'攻擊命中後 25% 機率讓對方下次攻擊傷害 ×0.9'}, attacks:[{name:'念力',dmg:61,cost:2,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'小偷',cost:5,type:'psychic',support:true,effect:'thief'},{name:'未來預知',dmg:107,cost:8,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'高周波音',dmg:155,cost:13,type:'normal',selfHeal:0.25}]},
  { mega:{spriteId:10311, type:'fire', type2:'steel', ability:{id:'blaze-boost', name:'熾熱核心', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:485, name:'席多藍恩', type:'fire', type2:'steel', hp:330, tier:3, ability:{id:'flash-fire', name:'引火', trigger:'onDefend', desc:'受到火屬性攻擊時完全免疫，下次攻擊威力 +20'}, attacks:[{name:'金屬爪',dmg:64,cost:10,type:'steel',megaBoost:true,bonusEnergy:5},{name:'熔岩爆發',dmg:69,cost:8,type:'fire',selfHeal:0.18},{name:'大字爆炎',dmg:85,cost:8,type:'fire',status:{effect:'poison', chance:0.3}},{name:'隕石衝擊',dmg:85,cost:8,type:'rock',status:{effect:'confusion', chance:0.25}}]},
  { mega:{spriteId:10312, type:'dark', type2:null, ability:{id:'tough-claws', name:'暗影', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:491, name:'達克萊伊', type:'dark', hp:310, tier:3, ability:{id:'tough-claws', name:'惡夢', trigger:'onAttack', desc:'攻擊傷害 +40'}, attacks:[{name:'惡意彈珠',dmg:66,cost:5,type:'dark',megaBoost:true,bonusEnergy:8},{name:'暗影球',dmg:105,cost:9,type:'ghost',megaBoost:true,bonusEnergy:7},{name:'黑暗脈動',dmg:149,cost:14,type:'dark',selfHeal:0.26},{name:'暗黑爆破',dmg:150,cost:14,type:'dark',status:{effect:'burn', chance:0.25}}]},
  { mega:{spriteId:10286, type:'fire', type2:'fighting', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對方的防禦型特性'}}, id:500, name:'炎武王', type:'fire', type2:'fighting', hp:300, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'火花',dmg:57,cost:3,type:'fire',megaBoost:true,bonusEnergy:6},{name:'近身戰',dmg:92,cost:7,type:'fighting',megaBoost:true,bonusEnergy:5},{name:'熔岩爆發',dmg:133,cost:12,type:'fire',selfHeal:0.28},{name:'超級power',dmg:136,cost:13,type:'fighting',selfHeal:0.29}]},
  { mega:{spriteId:10287, type:'ground', type2:'steel', ability:{id:'tough-claws', name:'貫穿之鑽', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:530, name:'龍頭地鼠', type:'ground', type2:'steel', hp:300, tier:2, ability:{id:'blaze-boost', name:'沙之力', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'金屬爪',dmg:67,cost:4,type:'steel',megaBoost:true,bonusEnergy:7},{name:'泥巴射擊',dmg:102,cost:9,type:'ground',megaBoost:true,bonusEnergy:7},{name:'地震',dmg:144,cost:14,type:'ground',selfHeal:0.18},{name:'鑽鑿',dmg:147,cost:14,type:'steel',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10288, type:'bug', type2:'poison', ability:{id:'sturdy', name:'硬殼盔甲', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}}, id:545, name:'蜈蚣王', type:'bug', type2:'poison', hp:260, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'連續啃咬',dmg:53,cost:1,type:'bug',megaBoost:true,bonusEnergy:5},{name:'小偷',cost:5,type:'bug',support:true,effect:'thief'},{name:'百萬針',dmg:91,cost:8,type:'bug',megaBoost:true,bonusEnergy:6},{name:'污泥炸彈',dmg:131,cost:13,type:'poison',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10289, type:'dark', type2:'fighting', ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}}, id:560, name:'頭巾混混', type:'dark', type2:'fighting', hp:240, tier:1, ability:{id:'status-immune-once', name:'淬鍊之心', trigger:'onStatus', desc:'首次被施加異常狀態時解除並免疫，之後攻擊傷害永久 +40'}, attacks:[{name:'小偷',cost:5,type:'dark',support:true,effect:'thief'},{name:'惡意彈珠',dmg:100,cost:7,type:'dark',megaBoost:true,bonusEnergy:5},{name:'近身戰',dmg:97,cost:7,type:'fighting',megaBoost:true,bonusEnergy:5},{name:'暗黑爆破',dmg:150,cost:11,type:'dark',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10290, type:'electric', type2:null, ability:{id:'motor-drive', name:'電鰻升格', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:604, name:'麻麻鰻魚王', type:'electric', hp:270, tier:2, ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'咬碎',dmg:69,cost:4,type:'dark',megaBoost:true,bonusEnergy:7},{name:'電擊',dmg:105,cost:10,type:'electric',megaBoost:true,bonusEnergy:8},{name:'十萬伏特',dmg:101,cost:10,type:'electric',megaBoost:true,bonusEnergy:8},{name:'冰凍吐息',cost:3,type:'electric',support:true,effect:'debuff',status:{effect:'freeze', chance:1}}]},
  { mega:{spriteId:10292, type:'grass', type2:'fighting', ability:{id:'solid-rock', name:'防彈', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:652, name:'布里卡隆', type:'grass', type2:'fighting', hp:300, tier:2, ability:{id:'blaze-boost', name:'茂盛', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'藤鞭',dmg:53,cost:2,type:'grass',megaBoost:true,bonusEnergy:6},{name:'空手劈',dmg:93,cost:8,type:'fighting',megaBoost:true,bonusEnergy:6},{name:'葉刃',dmg:134,cost:12,type:'grass',selfHeal:0.19},{name:'近身戰',dmg:134,cost:13,type:'fighting',selfHeal:0.16}]},
  { mega:{spriteId:10293, type:'fire', type2:'psychic', ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:655, name:'妖火紅狐', type:'fire', type2:'psychic', hp:260, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'火花',dmg:60,cost:3,type:'fire',megaBoost:true,bonusEnergy:6},{name:'念力',dmg:98,cost:8,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'影舞',cost:2,type:'fire',support:true,effect:'shadow-dance'},{name:'未來預知',dmg:136,cost:14,type:'psychic',status:{effect:'confusion', chance:0.25}}]},
  { mega:{spriteId:10295, type:'fire', type2:'normal', ability:{id:'blaze-boost', name:'火鬃', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:668, name:'火炎獅', type:'fire', type2:'normal', hp:270, tier:2, ability:{id:'pressure', name:'緊張感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'拍打',dmg:70,cost:5,type:'normal',megaBoost:true,bonusEnergy:8},{name:'撐住',cost:5,type:'fire',support:true,effect:'brace'},{name:'大字爆炎',dmg:105,cost:10,type:'fire',megaBoost:true,bonusEnergy:8},{name:'高周波音',dmg:150,cost:15,type:'normal',selfHeal:0.24}]},
  { mega:{spriteId:10296, type:'fairy', type2:null, ability:{id:'adaptability', name:'妖精領域', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:670, name:'花葉蒂', type:'fairy', hp:200, tier:1, ability:{id:'frisk-ward', name:'花之守護', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'魔法閃耀',dmg:62,cost:0,type:'fairy',megaBoost:true,bonusEnergy:4},{name:'劍舞',cost:4,type:'fairy',support:true,effect:'sword-dance'},{name:'月亮之力',dmg:96,cost:6,type:'fairy',megaBoost:true,bonusEnergy:4},{name:'葉暴風',dmg:144,cost:11,type:'grass',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10314, type:'psychic', type2:null, ability:{id:'trace', name:'複製', trigger:'onEnter', desc:'上場時複製對手當前的特性'}}, id:678, name:'超能妙喵', type:'psychic', hp:220, tier:1, ability:{id:'chance-debuff', name:'穿透', trigger:'onAttack', desc:'攻擊命中後 25% 機率讓對方下次攻擊傷害 ×0.9'}, attacks:[{name:'念力',dmg:73,cost:3,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'毒粉',cost:1,type:'psychic',support:true,effect:'debuff',status:{effect:'poison', chance: 1}},{name:'未來預知',dmg:116,cost:9,type:'psychic',megaBoost:true,bonusEnergy:7},{name:'暗黑爆破',dmg:173,cost:14,type:'dark',status:{effect:'sleep', chance:0.2}}]},
  { mega:{spriteId:10297, type:'dark', type2:'psychic', ability:{id:'huge-power', name:'唱反調', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:687, name:'烏賊王', type:'dark', type2:'psychic', hp:260, tier:2, ability:{id:'shield-invert', name:'顛倒之心', trigger:'onDefend', desc:'對手的防禦加成效果對自己反而變成傷害加成'}, attacks:[{name:'惡意彈珠',dmg:54,cost:2,type:'dark',megaBoost:true,bonusEnergy:6},{name:'念力',dmg:95,cost:8,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'集氣',cost:3,type:'dark',support:true,effect:'focus-energy',bonusEnergy:9},{name:'未來預知',dmg:131,cost:13,type:'psychic',selfHeal:0.21}]},
  { mega:{spriteId:10298, type:'rock', type2:'fighting', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:689, name:'龜足巨鎧', type:'rock', type2:'water', hp:260, tier:2, ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}, attacks:[{name:'岩石滑落',dmg:55,cost:3,type:'rock',megaBoost:true,bonusEnergy:6},{name:'冥想',cost:3,type:'rock',support:true,effect:'meditate'},{name:'石刃',dmg:96,cost:8,type:'rock',megaBoost:true,bonusEnergy:6},{name:'衝浪',dmg:140,cost:14,type:'water',selfHeal:0.21}]},
  { mega:{spriteId:10299, type:'poison', type2:'dragon', ability:{id:'thick-fat', name:'再生力', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}}, id:691, name:'毒藻龍', type:'poison', type2:'dragon', hp:260, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'毒液',dmg:61,cost:4,type:'poison',megaBoost:true,bonusEnergy:7},{name:'詭計',cost:3,type:'poison',support:true,effect:'trick'},{name:'污泥炸彈',dmg:100,cost:9,type:'poison',megaBoost:true,bonusEnergy:7},{name:'龍之波動',dmg:142,cost:14,type:'dragon',selfHeal:0.15}]},
  { mega:{spriteId:10300, type:'fighting', type2:'flying', ability:{id:'huge-power', name:'無防守', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:701, name:'摔角鷹人', type:'fighting', type2:'flying', hp:230, tier:1, ability:{id:'desperate-blade', name:'輕盈', trigger:'onAttack', desc:'HP 低於 50% 時，攻擊傷害 +40'}, attacks:[{name:'空手劈',dmg:83,cost:5,type:'fighting',megaBoost:true,bonusEnergy:8},{name:'羽棲',cost:8,type:'flying',support:true,effect:'roost'},{name:'近身戰',dmg:124,cost:10,type:'fighting',megaBoost:true,bonusEnergy:8},{name:'空氣斬',dmg:180,cost:15,type:'flying',status:{effect:'poison', chance:0.3}}]},
  { mega:{spriteId:10301, type:'dragon', type2:'ground', ability:{id:'solid-rock', name:'極巨腺體', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:718, name:'基格爾德', type:'dragon', type2:'ground', hp:360, tier:3, ability:{id:'solid-rock', name:'終結之地', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'咬碎',dmg:78,cost:13,type:'dark',megaBoost:true,bonusEnergy:8},{name:'泥巴射擊',dmg:96,cost:13,type:'ground',status:{effect:'burn', chance:0.25}},{name:'地震',dmg:96,cost:13,type:'ground',status:{effect:'paralysis', chance:0.2}},{name:'龍爪',dmg:96,cost:13,type:'dragon',selfHeal:0.21}]},
  { mega:{spriteId:10315, type:'fighting', type2:'ice', ability:{id:'tough-claws', name:'鐵拳', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:740, name:'好勝毛蟹', type:'fighting', type2:'ice', hp:270, tier:2, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'撐住',cost:5,type:'fighting',support:true,effect:'brace'},{name:'空手劈',dmg:102,cost:9,type:'fighting',megaBoost:true,bonusEnergy:7},{name:'冰凍拳',dmg:100,cost:9,type:'ice',megaBoost:true,bonusEnergy:7},{name:'近身戰',dmg:147,cost:14,type:'fighting',selfHeal:0.29}]},
  { mega:{spriteId:10302, type:'normal', type2:'dragon', ability:{id:'guts', name:'崩潰', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:780, name:'老翁龍', type:'normal', type2:'dragon', hp:300, tier:2, ability:{id:'guts', name:'崩潰', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'拍打',dmg:62,cost:3,type:'normal',megaBoost:true,bonusEnergy:6},{name:'龍之氣息',dmg:94,cost:8,type:'dragon',megaBoost:true,bonusEnergy:6},{name:'高周波音',dmg:140,cost:13,type:'normal',status:{effect:'confusion', chance:0.25}},{name:'龍之波動',dmg:136,cost:13,type:'dragon',selfHeal:0.28}]},
  { mega:{spriteId:10317, type:'steel', type2:'fairy', ability:{id:'huge-power', name:'心之力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:801, name:'瑪機雅娜', type:'steel', type2:'fairy', hp:310, tier:3, ability:{id:'huge-power', name:'心之力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}, attacks:[{name:'金屬爪',dmg:67,cost:5,type:'steel',megaBoost:true,bonusEnergy:8},{name:'魔法閃耀',dmg:103,cost:10,type:'fairy',megaBoost:true,bonusEnergy:8},{name:'重磅衝撞',dmg:150,cost:15,type:'steel',selfHeal:0.16},{name:'月亮之力',dmg:150,cost:15,type:'fairy',selfHeal:0.18}]},
  { mega:{spriteId:10319, type:'electric', type2:null, ability:{id:'motor-drive', name:'蓄電', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:807, name:'捷拉奧拉', type:'electric', hp:310, tier:3, ability:{id:'motor-drive', name:'蓄電', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'電擊',dmg:66,cost:4,type:'electric',megaBoost:true,bonusEnergy:7},{name:'空手劈',dmg:104,cost:10,type:'fighting',megaBoost:true,bonusEnergy:8},{name:'十萬伏特',dmg:148,cost:15,type:'electric',status:{effect:'freeze', chance:0.15}},{name:'近身戰',dmg:147,cost:15,type:'fighting',selfHeal:0.24}]},
  { mega:{spriteId:10303, type:'fighting', type2:null, ability:{id:'guts', name:'不服輸', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:870, name:'列陣兵', type:'fighting', hp:230, tier:1, ability:{id:'sturdy', name:'戰鬥盔甲', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}, attacks:[{name:'空手劈',dmg:82,cost:5,type:'fighting',megaBoost:true,bonusEnergy:8},{name:'詭計',cost:3,type:'fighting',support:true,effect:'trick'},{name:'近身戰',dmg:124,cost:10,type:'fighting',megaBoost:true,bonusEnergy:8},{name:'超強衝擊',dmg:180,cost:15,type:'fighting',selfHeal:0.18}]},
  { mega:{spriteId:10320, type:'grass', type2:'fire', ability:{id:'blaze-boost', name:'辣椒噴霧', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:952, name:'狠辣椒', type:'grass', type2:'fire', hp:220, tier:1, ability:{id:'insomnia', name:'不眠', trigger:'onDefend', desc:'不會陷入睡眠狀態'}, attacks:[{name:'藤鞭',dmg:72,cost:2,type:'grass',megaBoost:true,bonusEnergy:6},{name:'冥想',cost:3,type:'grass',support:true,effect:'meditate'},{name:'葉刃',dmg:106,cost:8,type:'grass',megaBoost:true,bonusEnergy:6},{name:'大字爆炎',dmg:158,cost:12,type:'fire',status:{effect:'paralysis', chance:0.2}}]},
  { mega:{spriteId:10321, type:'rock', type2:'poison', ability:{id:'adaptability', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:970, name:'晶光花', type:'rock', type2:'poison', hp:260, tier:2, ability:{id:'poison-point', name:'毒素碎片', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'岩石滑落',dmg:50,cost:1,type:'rock',megaBoost:true,bonusEnergy:5},{name:'毒液',dmg:89,cost:7,type:'poison',megaBoost:true,bonusEnergy:5},{name:'冥想',cost:3,type:'rock',support:true,effect:'meditate'},{name:'污泥炸彈',dmg:127,cost:12,type:'poison',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10322, type:'dragon', type2:'water', ability:{id:'huge-power', name:'指揮', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:978, name:'米立龍', type:'dragon', type2:'water', hp:210, tier:1, ability:{id:'legacy-boost', name:'指揮', trigger:'onLeave', desc:'陣亡或被換下場時，下一隻上場的我方寶可夢首次攻擊：能量消耗×0.5、傷害+40'}, attacks:[{name:'水槍',dmg:72,cost:1,type:'water',megaBoost:true,bonusEnergy:5},{name:'龍之氣息',dmg:65,cost:1,type:'dragon',megaBoost:true,bonusEnergy:5},{name:'影舞',cost:2,type:'dragon',support:true,effect:'shadow-dance'},{name:'龍之波動',dmg:155,cost:11,type:'dragon',status:{effect:'freeze', chance:0.15}}]},
  { mega:{spriteId:10325, type:'dragon', type2:'ice', ability:{id:'guts', name:'熱交換', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:998, name:'戟脊龍', type:'dragon', type2:'ice', hp:340, tier:3, ability:{id:'guts', name:'熱交換', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'冰霜拳',dmg:67,cost:11,type:'ice',megaBoost:true,bonusEnergy:6},{name:'龍息',dmg:72,cost:9,type:'dragon',status:{effect:'confusion', chance:0.25}},{name:'冰凍光束',dmg:88,cost:9,type:'ice',selfHeal:0.23},{name:'逆鱗',dmg:72,cost:9,type:'dragon',selfHeal:0.17}]},
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
  bug:      {grass:2, psychic:2, dark:2, fire:0.5, fighting:0.5, poison:0.5, flying:0.5, ghost:0.5, steel:0.5, fairy:0.5},
};

const TRAINERS = [
  // ── items ──
  {id:'potion-m',   name:'傷藥（中）', cat:'item',      desc:'回復上場寶可夢 40 HP'},
  {id:'potion-l',   name:'傷藥（大）', cat:'item',      desc:'回復上場寶可夢 60 HP'},
  {id:'potion-xl',  name:'傷藥（特大）', cat:'item',    desc:'回復上場寶可夢 80 HP'},
  {id:'x-atk',      name:'攻擊強化',   cat:'item',      desc:'下次攻擊威力 +40'},
  {id:'x-def',      name:'防禦強化',   cat:'item',      desc:'下次受傷害減少 40'},
  {id:'energize',   name:'能量強化',   cat:'item',      desc:'下次攻擊傷害 ×1.2，但自身損失 50 HP'},
  {id:'antidote',   name:'萬能藥',     cat:'item',      desc:'解除上場寶可夢的異常狀態'},
  {id:'fire-bomb',  name:'火焰彈',     cat:'item',      type:'fire', weight:10,    desc:'讓對手上場寶可夢陷入燒傷'},
  {id:'gas-attack', name:'瓦斯攻擊',   cat:'item',      type:'poison', weight:10,  desc:'讓對手上場寶可夢陷入中毒'},
  {id:'switcher',   name:'交換器',     cat:'item',      desc:'讓對手上場寶可夢與備戰寶可夢隨機互換'},
  {id:'reflect',    name:'反彈鏡',     cat:'item',      desc:'下回合對手的攻擊傷害反彈回自身'},
  // 屬性轉換 listed 6× — it replaced 13 separate single-type orb cards, so without extra
  // weight here its draw chance would have quietly dropped ~10x (1/13 of before) even though
  // qualitatively every draw of it is now useful (unlike the old orbs, which only helped if you
  // happened to draw the one matching type) — reported by the user as "一直抽不到屬性轉換".
  {id:'type-orb',   name:'屬性轉換',   cat:'item',      desc:'選擇一個屬性，本回合攻擊視為該屬性（可享有屬性加成）'},
  {id:'type-orb',   name:'屬性轉換',   cat:'item',      desc:'選擇一個屬性，本回合攻擊視為該屬性（可享有屬性加成）'},
  {id:'type-orb',   name:'屬性轉換',   cat:'item',      desc:'選擇一個屬性，本回合攻擊視為該屬性（可享有屬性加成）'},
  {id:'type-orb',   name:'屬性轉換',   cat:'item',      desc:'選擇一個屬性，本回合攻擊視為該屬性（可享有屬性加成）'},
  {id:'type-orb',   name:'屬性轉換',   cat:'item',      desc:'選擇一個屬性，本回合攻擊視為該屬性（可享有屬性加成）'},
  {id:'type-orb',   name:'屬性轉換',   cat:'item',      desc:'選擇一個屬性，本回合攻擊視為該屬性（可享有屬性加成）'},
  {id:'retreat-vest', name:'撤退背心', cat:'item',      desc:'下次換場不會結束回合'},
  {id:'confuse-potion', name:'混亂藥', cat:'item',      type:'psychic', weight:10, desc:'讓對手上場寶可夢陷入混亂'},
  {id:'absolute-zero', name:'絕對零度', cat:'item',     type:'ice', weight:10,     desc:'讓對手上場寶可夢陷入結凍'},
  {id:'energy-patch-l', name:'能量補丁（大）', cat:'item', desc:'回復 4 點能量'},
  {id:'hand-wreck', name:'手牌破壞',   cat:'item',      desc:'讓對方隨機棄掉 1 張手牌'},
  {id:'energy-drain', name:'能量剝奪', cat:'item',      desc:'讓對方損失 6 點能量'},
  {id:'gamble',     name:'一擲千金',   cat:'item',      desc:'30% 機率下次攻擊傷害 ×1.6；70% 機率自身損失 40% 最大HP'},
  {id:'desperate-boost', name:'背水一戰', cat:'item',   desc:'HP 越低，下次攻擊威力加成越高（最高 +50）'},
  {id:'double-strike', name:'連擊',     cat:'item',    desc:'下次攻擊傷害 +40，異常狀態機率額外判定一次'},
  {id:'plunder',    name:'掠奪',       cat:'item',      desc:'隨機搶奪對手一張手牌'},
  {id:'comm-seal',  name:'通訊封印',   cat:'item',      desc:'下回合對手不能使用支援者卡'},
  {id:'ability-seal', name:'封印特性', cat:'item',      desc:'封印對手的特性 2 回合，期間視為沒有特性'},
  {id:'heal-seal',  name:'詛咒',       cat:'item',      desc:'對手的恢復效果 2 回合內全部失效（道具回血／特性回血／招式回血皆無效）'},
  // ── items：屬性分類卡（依場上寶可夢屬性抽取，優先補之前完全沒有主題卡的屬性）──
  {id:'paralyze-trap', name:'電擊誘餌', cat:'item', type:'electric', weight:10, desc:'讓對手上場寶可夢陷入麻痺'},
  {id:'curse-drain',   name:'詛咒波動', cat:'item', type:'ghost', weight:10,    desc:'讓對方損失 8 點能量，自身回復 20 HP'},
  {id:'iron-guard',    name:'鋼鐵裝甲', cat:'item', type:'steel', weight:10,   desc:'下次受到傷害減少 70'},
  {id:'night-raid',    name:'夜襲',     cat:'item', type:'dark', weight:10,    desc:'隨機搶奪對手 2 張手牌'},
  {id:'tailwind',      name:'順風',     cat:'item', type:'flying', weight:10,  desc:'下次攻擊若為飛行屬性，傷害 +40'},
  {id:'fairy-wind',    name:'妖精之光', cat:'item', type:'fairy', weight:10,   desc:'解除上場寶可夢異常狀態並回復 40 HP'},
  {id:'swarm-sting',   name:'群聚針刺', cat:'item', type:'bug', weight:10,     desc:'讓對手陷入中毒，並損失 3 點能量'},
  {id:'tidal-heal',    name:'潮汐回復', cat:'item', type:'water', weight:10,   desc:'回復上場寶可夢 30% 最大HP'},
  {id:'dragon-pulse',  name:'龍之波動', cat:'item', type:'dragon', weight:10,  desc:'下次攻擊若為龍屬性，傷害 ×1.12'},
  {id:'focus-punch',   name:'捨身猛擊', cat:'item', type:'fighting', weight:10,desc:'下次攻擊威力 +40，但自身 HP ×0.8'},
  // ── supporters ──
  {id:'revive',     name:'復活藥',     cat:'supporter', desc:'復活備戰欄第一隻倒下的寶可夢（回復 40 HP，每場限用一次）'},
  {id:'nurse',      name:'治療師',     cat:'supporter', desc:'上場寶可夢完全回復 HP 並解除異常狀態'},
  {id:'all-out',    name:'全力出擊',   cat:'supporter', desc:'下次攻擊傷害 ×1.2，但下回合無法回復能量'},
  {id:'sacrifice',      name:'搏命',       cat:'supporter', desc:'我方與對方上場寶可夢同歸於盡'},
  {id:'mad-scientist',  name:'瘋狂博士',   cat:'supporter', desc:'選我方一隻寶可夢，變身成我方或對方一隻陣亡的寶可夢（回復變身後 50% HP）'},
  {id:'cheerleader',    name:'啦啦隊',     cat:'supporter', desc:'將能量補滿到 20'},
  {id:'hunt',           name:'獵捕',       cat:'supporter', desc:'指定對手一隻備戰寶可夢強制上場（不觸發上場特性），並造成 40 點固定傷害（會計算屬性相剋）'},
  // ── 支援者牌：屬性分類新卡（18種屬性各一張，補齊「每種屬性都有專屬支援者卡」的空缺；
  //   刻意少放補血、多放幽靈/惡這兩張封印Mega進化——使用者原話「補血卡少一點，多一些封印」）──
  {id:'fire-nova',      name:'灼焒爆發',   cat:'item', type:'fire', weight:10,     desc:'下次攻擊威力 +60，30% 機率讓對手灼傷'},
  {id:'abyssal-power',  name:'深海之力',   cat:'item', type:'water', weight:10,    desc:'下次攻擊消耗能量減半'},
  {id:'earthen-wall',   name:'大地壁壘',   cat:'item', type:'ground', weight:10,   desc:'下次受到攻擊傷害減少 90'},
  {id:'lightning-dash', name:'電光石火',   cat:'item', type:'electric', weight:10, desc:'本回合這次攻擊不消耗能量'},
  {id:'leech-seed',     name:'寄生種子',   cat:'item', type:'grass', weight:10,    desc:'接下來 3 回合，每回合開始吸取對方 3 點能量轉為自己能量'},
  {id:'mind-focus',     name:'心靈感應',   cat:'item', type:'psychic', weight:10,  desc:'下次攻擊的異常狀態機率視為 100%'},
  {id:'breakthrough',   name:'直搗黃龍',   cat:'item', type:'fighting', weight:10, desc:'下次攻擊威力 +40，且無視對方的「受傷減少」效果'},
  {id:'wraith-curse',   name:'亡靈詛咒',   cat:'item', type:'ghost', weight:10,    desc:'封印對手 Mega 進化 2 回合，並讓對方損失 5 點能量'},
  {id:'dragon-might',   name:'龍神顯現',   cat:'item', type:'dragon', weight:10,   desc:'自身損失 25% 最大HP，下次攻擊威力 ×1.5'},
  {id:'steel-fortress', name:'鋼鐵壁壘',   cat:'item', type:'steel', weight:10,    desc:'下次受到攻擊傷害減少 100'},
  {id:'frost-armor',    name:'冰凍護甲',   cat:'item', type:'ice', weight:10,      desc:'下次受到攻擊傷害減少 60；若對方該次攻擊為冰屬性則完全無效'},
  {id:'quick-thinking', name:'隨機應變',   cat:'item', type:'normal', weight:10,   desc:'立即抽 2 張手牌'},
  {id:'shadow-lockdown',name:'暗影封鎖',   cat:'item', type:'dark', weight:10,     desc:'封印對手 Mega 進化 2 回合，並讓對方隨機棄 1 張手牌'},
  {id:'gale-dodge',     name:'疾風迴避',   cat:'item', type:'flying', weight:10,   desc:'下次受到攻擊有 50% 機率完全迴避'},
  {id:'tectonic-shift', name:'地殼變動',   cat:'item', type:'rock', weight:10,     desc:'立即清除目前的競技場效果'},
  {id:'fairy-barrier',  name:'妖精結界',   cat:'item', type:'fairy', weight:10,    desc:'接下來 2 回合，我方上場寶可夢免疫異常狀態'},
  {id:'toxic-pact',     name:'劇毒契約',   cat:'item', type:'poison', weight:10,   desc:'讓對方陷入中毒，並讓對方損失 10 點能量'},
  {id:'swarm-feast',    name:'蟲群啃食',   cat:'item', type:'bug', weight:10,      desc:'讓對方損失 8 點能量，其中 4 點轉給自己'},
  // ── 支援者牌屬性分類新卡 第二批（每種屬性再+2張，延續同一套屬性→機制對照表）──
  {id:'fire-fury',        name:'業火燎原',   cat:'item', type:'fire',     weight:10, desc:'若對手已有異常狀態，下次攻擊威力 +70；否則 +25'},
  {id:'fire-resolve',     name:'灰燼決意',   cat:'item', type:'fire',     weight:10, desc:'自身損失 15 點能量，下次攻擊威力 ×1.3'},
  {id:'water-recover',    name:'水流恢復',   cat:'item', type:'water',    weight:10, desc:'立即回復 8 點能量'},
  {id:'water-aegis',      name:'大海之盾',   cat:'item', type:'water',    weight:10, desc:'下次受到攻擊傷害減少 50，並立即回復 3 點能量'},
  {id:'ground-heal',      name:'大地治癒',   cat:'item', type:'ground',   weight:10, desc:'立即回復上場寶可夢 15% 最大HP'},
  {id:'ground-bulwark',   name:'磐石防禦',   cat:'item', type:'ground',   weight:10, desc:'下次受到攻擊傷害減少 70，並讓對手下次攻擊威力 ×0.9'},
  {id:'electric-charge',  name:'高速充能',   cat:'item', type:'electric', weight:10, desc:'立即回復 10 點能量'},
  {id:'electric-chain',   name:'連鎖閃電',   cat:'item', type:'electric', weight:10, desc:'讓對手有 40% 機率立即陷入麻痺'},
  {id:'grass-bind',       name:'藤蔓束縛',   cat:'item', type:'grass',    weight:10, desc:'讓對手立即損失 6 點能量'},
  {id:'grass-photosyn',   name:'光合作用',   cat:'item', type:'grass',    weight:10, desc:'立即回復 10 點能量；若自身HP低於50%額外回復 8 HP'},
  {id:'psychic-disrupt',  name:'精神干擾',   cat:'item', type:'psychic',  weight:10, desc:'讓對方隨機棄掉 1 張手牌'},
  {id:'psychic-foresight',name:'未來視',     cat:'item', type:'psychic',  weight:10, desc:'下次攻擊威力 +50；若對手已有異常狀態額外 +30'},
  {id:'fighting-crush',   name:'崩拳',       cat:'item', type:'fighting', weight:10, desc:'下次攻擊威力 +60；若對手當下持有防禦加成額外 +30'},
  {id:'fighting-ironfist',name:'鋼鐵之拳',   cat:'item', type:'fighting', weight:10, desc:'讓對手下次攻擊威力 ×0.85'},
  {id:'ghost-drain',      name:'幽冥追跡',   cat:'item', type:'ghost',    weight:10, desc:'讓對手損失 8 點能量，並讓對方隨機棄掉 1 張手牌'},
  {id:'ghost-obsession',  name:'怨念集中',   cat:'item', type:'ghost',    weight:10, desc:'下次攻擊異常狀態機率視為 100%；若對手為 Mega 型態額外 +40 威力'},
  {id:'dragon-fang',      name:'逆鱗',       cat:'item', type:'dragon',   weight:10, desc:'下次攻擊威力 +90，自身損失 10 點能量'},
  {id:'dragon-cleanse',   name:'龍息滌蕩',   cat:'item', type:'dragon',   weight:10, desc:'解除自身異常狀態，並回復 5 HP'},
  {id:'steel-resolve',    name:'鋼鐵意志',   cat:'item', type:'steel',    weight:10, desc:'下次受到攻擊傷害減少 50，並立即回復 5 點能量'},
  {id:'steel-flash',      name:'鎂光反射',   cat:'item', type:'steel',    weight:10, desc:'下次受到攻擊傷害減少 40，並讓對手下次攻擊威力 ×0.9'},
  {id:'ice-howl',         name:'冰霜咆哮',   cat:'item', type:'ice',      weight:10, desc:'讓對手有 35% 機率立即陷入結凍'},
  {id:'ice-barrier',      name:'極寒屏障',   cat:'item', type:'ice',      weight:10, desc:'下次受到攻擊傷害減少 40，接下來 1 回合免疫異常狀態'},
  {id:'normal-allout',    name:'全力以赴',   cat:'item', type:'normal',   weight:10, desc:'下次攻擊威力 +35，且這次攻擊不消耗能量'},
  {id:'normal-refresh',   name:'換氣追擊',   cat:'item', type:'normal',   weight:10, desc:'立即抽 1 張手牌，並回復 4 點能量'},
  {id:'dark-heist',       name:'暗夜掠奪',   cat:'item', type:'dark',     weight:10, desc:'隨機搶奪對手 1 張手牌到自己手上'},
  {id:'dark-ambush',      name:'不意打擊',   cat:'item', type:'dark',     weight:10, desc:'下次攻擊威力 +50，並讓對手下次攻擊威力 ×0.9'},
  {id:'flying-dance',     name:'疾風之舞',   cat:'item', type:'flying',   weight:10, desc:'下次攻擊威力 ×1.2，且下次受到攻擊傷害減少 30'},
  {id:'flying-gale',      name:'暴風捲',     cat:'item', type:'flying',   weight:10, desc:'讓對手立即損失 8 點能量'},
  {id:'rock-slide',       name:'岩崩',       cat:'item', type:'rock',     weight:10, desc:'下次攻擊威力 +55；若場上有競技場效果額外 +25'},
  {id:'rock-fortress',    name:'坐地為王',   cat:'item', type:'rock',     weight:10, desc:'下次受到攻擊傷害減少 60'},
  {id:'fairy-song',       name:'妖精之歌',   cat:'item', type:'fairy',    weight:10, desc:'讓對手有 30% 機率立即陷入混亂'},
  {id:'fairy-heal',       name:'治癒之風',   cat:'item', type:'fairy',    weight:10, desc:'解除自身異常狀態，並回復 10 HP'},
  {id:'poison-spore',     name:'劇毒孢子',   cat:'item', type:'poison',   weight:10, desc:'讓對手有 50% 機率立即陷入中毒'},
  {id:'poison-strike',    name:'猛毒突襲',   cat:'item', type:'poison',   weight:10, desc:'下次攻擊威力 +40；若對手已中毒額外 +40'},
  {id:'bug-web',          name:'蟲網束縛',   cat:'item', type:'bug',      weight:10, desc:'讓對手損失 6 點能量，自身下次攻擊威力 +20'},
  {id:'bug-swarm',        name:'群聚共鳴',   cat:'item', type:'bug',      weight:10, desc:'立即回復 6 點能量，並抽 1 張手牌'},
  // ── stadium ──
  {id:'stadium-training',      name:'訓練場',     cat:'stadium', desc:'場上所有技能威力 +45（雙方）'},
  {id:'stadium-spring',        name:'地熱溫泉',   cat:'stadium', desc:'每回合結束，雙方上場寶可夢各回復 30 HP'},
  {id:'stadium-reversal',      name:'逆轉鬥技場', cat:'stadium', desc:'HP 低於 50% 時，攻擊威力 +65'},
  {id:'stadium-invert',        name:'反轉世界',   cat:'stadium', desc:'場上屬性相剋完全反轉（克制↔抵抗，免疫→克制×1.2）；反轉後仍是克制的攻擊，額外 +25 固定傷害'},
  {id:'stadium-dragon-valley', name:'龍之谷',     cat:'stadium', type:'dragon', weight:10, desc:'龍屬性寶可夢對妖精、冰系招式不受克制（效果最多×1）；龍屬性攻擊不會被減免或無效，且額外 +35 固定傷害'},
  {id:'stadium-evil-forest',   name:'邪惡森林',   cat:'stadium', type:'grass', weight:10, desc:'原本克制草屬性的寶可夢（火／冰／飛行／毒／蟲），全部變成弱草屬性（草屬性攻擊 ×1.6）'},
  {id:'stadium-mega-prism',    name:'Mega 稜鏡塔', cat:'stadium', desc:'雙方每個自己的回合開始時，獲得 16 點 Mega 能量'},
  {id:'stadium-spikes',        name:'尖峰陷阱',   cat:'stadium', desc:'寶可夢上場時，受到最大HP 25% 的傷害（雙方對等）'},
  {id:'stadium-toxic-field',   name:'劇毒領域',   cat:'stadium', type:'poison', weight:10, desc:'寶可夢上場時，陷入中毒（雙方對等）；此場地下中毒傷害 ×2'},
  {id:'stadium-colosseum',     name:'羅馬鬥技場', cat:'stadium', type:'fighting', weight:10, desc:'格鬥屬性招式傷害 ×1.4；格鬥屬性攻擊不再被幽靈屬性完全免疫'},
  {id:'stadium-mystic-space',  name:'魔幻空間',   cat:'stadium', type:'psychic', weight:10, desc:'超能力屬性寶可夢受到的傷害 ×0.75；弱點消失（不受超效傷害影響）'},
  {id:'stadium-lava',          name:'熔岩火山',   cat:'stadium', type:'fire', weight:10, desc:'火屬性招式傷害 +75；水屬性招式傷害 ×0.65'},
  {id:'stadium-ocean',         name:'海洋世界',   cat:'stadium', type:'water', weight:10, desc:'水屬性招式消耗能量 ×0.3；電屬性招式傷害 ×1.4'},
  {id:'stadium-shrine',        name:'莊嚴神社',   cat:'stadium', type:'normal', weight:10, desc:'一般屬性招式一律視為剋制對手（效果拉滿 ×1.8）'},
  // ── stadium：屬性分類新卡 ──
  {id:'stadium-sandstorm',   name:'沙塵暴',   cat:'stadium', type:'ground', weight:10, desc:'非地面／岩石／鋼屬性寶可夢，每回合結束損失最大HP的12%'},
  {id:'stadium-rock-field',  name:'岩石地帶', cat:'stadium', type:'rock', weight:10, desc:'岩石／地面／鋼屬性寶可夢，受到的攻擊傷害 -150'},
];

// 2026-07-22應使用者要求：抽牌／搶奪對方手牌效果太強（隨機應變/換氣追擊/群聚共鳴抽牌，
// 掠奪/夜襲/暗夜掠奪搶對方牌），改成跟支援者卡一樣「每回合限用一次」（跨這6張卡共用同一個
// 每回合旗標，不是各卡各自一次）——見G[role+'HandCardUsed']。
const HAND_MANIPULATION_CARDS = ['plunder', 'night-raid', 'dark-heist', 'quick-thinking', 'normal-refresh', 'bug-swarm'];

const STATUS_ZH = {poison:'中毒',burn:'燒傷',paralysis:'麻痺',sleep:'睡眠',freeze:'結凍',confusion:'混亂'};

/* 「我的寶可夢」可選寵物白名單——御三家初形態＋皮卡丘為主要選項，另外「客製化寶可夢」提供幾隻御三家以外
   的選擇（custom:true）。獨立於戰鬥用的POKEMON陣列，不需要招式/特性資料 */
const PET_SPECIES = [
  { id: 1,   name: '妙蛙種子', type: 'grass' },
  { id: 4,   name: '小火龍',   type: 'fire' },
  { id: 7,   name: '傑尼龜',   type: 'water' },
  { id: 152, name: '菊草葉',   type: 'grass' },
  { id: 155, name: '火球鼠',   type: 'fire' },
  { id: 158, name: '小鋸鱷',   type: 'water' },
  { id: 25,  name: '皮卡丘',   type: 'electric' },
  { id: 722, name: '木木梟',   type: 'grass' },
  { id: 906, name: '新葉喵',   type: 'grass' },
  { id: 909, name: '呆火鱷',   type: 'fire' },
  { id: 92,  name: '鬼斯',     type: 'ghost',  custom: true },
  { id: 132, name: '百變怪',   type: 'normal', custom: true },
  { id: 133, name: '伊布',     type: 'normal', custom: true },
];

/* 徽章登記表——GM後台手動指定給玩家（還沒有自動判定/結算機制）。
   圖檔放在 public/badges/，用id當檔名前綴方便之後新增別種徽章。 */
const BADGES = {
  'weekly-champion':    { name: '週排行榜冠軍',   image: '/badges/weekly-champion-01.png' },
  'weekly-participant': { name: '週排行榜參與徽章', image: '/badges/weekly-participant-01.png' },
  'sea-emperor':        { name: '海皇降臨',       image: '/badges/sea-emperor-01.gif' },
};

/* 商城道具——跟屬性無關的通用房間裝飾/穿搭，買了永久持有（不是消耗品），純資料registry，
   新增道具不需要碰前端邏輯（跟BADGES同一套設計）。category:'decor'放房間3插槽任一個；
   穿搭類道具已經整個移除（2026-07-18，使用者放棄裝扮方向——sprite來源差異太大，
   校正好幾輪眼鏡位置還是對不準，改走「小夥伴寶可夢繞著跑」的方向，見皮丘companion章節）。 */
const SHOP_ITEMS = {
  'lamp-warm':     { name: '暖色檯燈', price: 30, icon: '🪔', category: 'decor' },
  'rug-round':     { name: '圓形地毯', price: 25, icon: '🟤', category: 'decor' },
  'plant-pot':     { name: '觀葉植物', price: 20, icon: '🪴', category: 'decor' },
  'picture-frame': { name: '掛畫',     price: 35, icon: '🖼️', category: 'decor' },
  'toy-ball':      { name: '玩具球',   price: 15, icon: '⚽', category: 'decor' },
  // 寶可夢球——消耗品，跟上面裝飾品的一次性擁有邏輯不同，允許重複購買囤貨（見 /api/pet/buy 的 category==='ball' 分支）。
  // iconUrl 用PokeAPI真的道具sprite（不是emoji湊數），前端渲染時偵測到iconUrl就改用<img>
  'ball-normal': { name: '一般球', price: 1,  iconUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/poke-ball.png',   category: 'ball', ballField: 'ball_normal' },
  'ball-great':  { name: '超級球', price: 5,  iconUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/great-ball.png',  category: 'ball', ballField: 'ball_great' },
  'ball-ultra':  { name: '高級球', price: 10, iconUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/ultra-ball.png',  category: 'ball', ballField: 'ball_ultra' },
};
// 球的等級 → 捕捉基礎成功率（丟球小遊戲用，寶可夢 tier 越高會再往下修正，見 /api/pet/catch/throw）
// 2026-07-21 應使用者要求調高：一般30%→45%、超級55%→70%、高級80%→92%，tier修正也放寬一些
const BALL_CATCH_RATE = { 'ball-normal': 0.45, 'ball-great': 0.70, 'ball-ultra': 0.92 };
const CATCH_TIER_MULT = { 1: 1, 2: 0.9, 3: 0.82 };
// 丟球沒抓到時，1%機率讓寶可夢「激烈反抗」直接逃跑結束這次遭遇；其餘99%只是這次沒抓到，
// 玩家還有球的話可以在同一次遭遇裡繼續丟，不用重新花100金幣encounter
const FIERCE_RESISTANCE_CHANCE = 0.01;
const CATCH_GIVEUP_REFUND = 90; // encounter花100，玩家選擇放棄退90（扣的10算「探索費」不退）
// 進行中的捕捉遭遇（伺服器記憶體）——玩家encounter完、決定要不要丟球/放棄之前，記住是哪隻野生寶可夢，
// 防止client直接偽造pokemonId呼叫throw/giveup跳過encounter的100金幣費用
const activeEncounters = new Map(); // userId -> { pokemonId, name, tier, expiresAt }
const ENCOUNTER_TTL_MS = 5 * 60 * 1000;
// 隊伍已滿10隻時，捕捉成功但還沒決定要放生誰的暫存狀態（伺服器記憶體，不用開DB欄位存這種短命的中繼狀態）——
// 防止client跳過encounter/throw流程，直接偽造一次「捕捉成功」呼叫resolve-release把任意寶可夢塞進隊伍
const pendingCatchReleases = new Map(); // userId -> { pokemonId, expiresAt }
const PENDING_RELEASE_TTL_MS = 2 * 60 * 1000;
// 房間裝飾/徽章改成自由拖曳座標(0~1標準化分數)後不再有固定插槽數量限制，
// 改用「同時擺放幾件」的上限防止房間被塞爆——使用者要求維持上限（不是取消），裝飾用6件，
// 徽章因為目前種類還很少（見BADGES）暫時給寬鬆一點的4個上限。
const DECOR_PLACE_LIMIT = 6;
const BADGE_PLACE_LIMIT = 4;

/* 釣魚結果registry——weight加總曾經=100可以直接當百分比讀，2026-07-20加入蓋歐卡（機率要精準到0.1%）
   後全部×10改用整數（加總=1001），蓋歐卡=1/1001≈0.0999%。黃金鯉魚王/紅色暴鯉龍/蓋歐卡刻意不生新素材，
   直接借用鯉魚王(129)/暴鯉龍(130)在正史遊戲裡本來就是的shiny配色（金色/紅色跟需求完全對上）、
   蓋歐卡(382)用一般配色搭配前端的海浪/發光特效，sprite網址組法見 spriteUrl()/rollFish() 呼叫端，
   不需要另外做圖。 */
const FISH_TYPES = {
  'none':            { name: '失敗',       weight: 500 },
  'magikarp':        { name: '鯉魚王',     weight: 200, speciesId: 129, shiny: false, sellPrice: 5 },
  'gyarados':        { name: '暴鯉龍',     weight: 150, speciesId: 130, shiny: false, sellPrice: 15 },
  'golden-magikarp': { name: '黃金鯉魚王', weight: 100, speciesId: 129, shiny: true,  sellPrice: 40 },
  'red-gyarados':    { name: '紅色暴鯉龍', weight: 50,  speciesId: 130, shiny: true,  sellPrice: 80 },
  'kyogre':          { name: '蓋歐卡',     weight: 1,   speciesId: 382, shiny: false, sellPrice: 500, legendary: true },
};
function rollFish() {
  const entries = Object.entries(FISH_TYPES);
  const total = entries.reduce((s, [, f]) => s + f.weight, 0); // 100
  let r = Math.random() * total;
  for (const [id, f] of entries) {
    if (r < f.weight) return id;
    r -= f.weight;
  }
  return entries[entries.length - 1][0]; // 保底，理論上浮點誤差以外不會走到這行
}

// 每天依好感度核發金幣的公式，抓保守值，之後可依實際商城價格調整
const DAILY_COIN_CAP = 20;
function dailyCoinsForHappiness(happiness) {
  return Math.min(DAILY_COIN_CAP, Math.round(happiness / 4));
}
// 飢餓值每經過這麼多秒掉1點，抓保守值，之後可依實際遊戲節奏調整
const HUNGER_DECAY_INTERVAL_SEC = 900;

/* ═══════════════════════════════════════════
   GAME LOGIC  (synchronous server-side)
═══════════════════════════════════════════ */
function clonePoke(p) {
  return { ...p, attacks: p.attacks.map(a => ({...a})), cur: p.hp, status: null,
    megaEvolved: p.mega ? false : undefined };
}

function effectiveCostSrv(atk, opponentPoke, G, buff) {
  if (buff?.costFree) return 0;
  let cost = atk.cost;
  if (G?.activeStadium?.id === 'stadium-ocean' && atk.type === 'water') cost = Math.floor(cost * 0.3);
  if (buff?.costHalved) cost = Math.floor(cost / 2);
  return cost;
}

function srvEff(atkType, defType, defType2) {
  const m1 = (EFF[atkType] || {})[defType] ?? 1;
  const m2 = defType2 ? ((EFF[atkType] || {})[defType2] ?? 1) : 1;
  return m1 * m2;
}

// 傷害倍率整體下修：所有超過/低於1的倍率，只保留原本「偏離1」部分的20%（2倍壓縮成1.2倍），完全無效(0)例外不受影響
function compressMult(m) {
  return m === 0 ? 0 : Math.round((1 + (m - 1) * 0.2) * 100) / 100;
}

const GRASS_COUNTER_TYPES = ['fire', 'ice', 'flying', 'poison', 'bug']; // 原本克制草屬性的攻擊方屬性
function srvEffActive(atkType, defType, defType2, G) {
  const eAtk = atkType;
  let m = srvEff(eAtk, defType, defType2);
  if (G?.activeStadium?.id === 'stadium-invert') {
    if (m === 0) m = 2;
    else if (m !== 1) m = 1 / m;
  }
  if (G?.activeStadium?.id === 'stadium-dragon-valley') {
    if ((defType === 'dragon' || defType2 === 'dragon') &&
        (eAtk === 'fairy' || eAtk === 'ice') && m > 1) m = 1;
    // 龍屬性攻擊不會被減免或無效——不管對面是什麼屬性，效果乘數至少要是1
    if (eAtk === 'dragon' && m < 1) m = 1;
  }
  if (G?.activeStadium?.id === 'stadium-evil-forest' && eAtk === 'grass') {
    // 原本克制草屬性的寶可夢（火／冰／飛行／毒／蟲），全部變成弱草屬性
    // 2026-07-22應使用者要求「場地卡全面加強」，把原本壓縮後只有×1.2的m=2提高到m=4（compressMult(4)=1.6）
    if (GRASS_COUNTER_TYPES.includes(defType) || GRASS_COUNTER_TYPES.includes(defType2)) m = 4;
  }
  if (G?.activeStadium?.id === 'stadium-colosseum') {
    if (eAtk === 'fighting' && (defType === 'ghost' || defType2 === 'ghost') && m === 0) m = 1;
  }
  if (G?.activeStadium?.id === 'stadium-mystic-space') {
    if ((defType === 'psychic' || defType2 === 'psychic') && m > 1) m = 1;
  }
  // 2026-07-22應使用者要求「場地卡全面加強」，把原本壓縮後只有×1.2的m=2提高到m=5（compressMult(5)=1.8）
  if (G?.activeStadium?.id === 'stadium-shrine' && eAtk === 'normal') {
    m = 5;
  }
  return compressMult(m);
}

function dealHand(n) {
  return [...TRAINERS].sort(() => Math.random() - 0.5).slice(0, n);
}

// 依場上寶可夢屬性過濾抽卡池：沒有type欄位的卡（通用卡）永遠都在池子裡，
// 有type欄位的卡只有在符合當前寶可夢的其中一個屬性時才會出現在池子裡（雙屬性=聯集）
function getDrawPool(type1, type2) {
  return TRAINERS.filter(c => c.cat !== 'supporter' && (!c.type || c.type === type1 || c.type === type2));
}

// 加權抽取：屬性道具卡 weight:10，其餘（含所有無屬性卡與競技場卡）預設 weight:1
function weightedPick(pool) {
  const total = pool.reduce((s, c) => s + (c.weight ?? 1), 0);
  let r = Math.random() * total;
  for (const c of pool) {
    const w = c.weight ?? 1;
    if (r < w) return c;
    r -= w;
  }
  return pool[pool.length - 1];
}

// Processes status before an attack. Mutates poke.
// Returns { skipped, died }
function handleStatus(poke, log, atkType) {
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
    if (Math.random() < 0.50) {
      log.push({ text: `${poke.name} 因麻痺無法行動！`, cls: 'special' });
      return { skipped: true, died: false };
    }
    return { skipped: false, died: false };
  }

  if (st.type === 'freeze') {
    if (atkType === 'fire') {
      poke.status = null;
      log.push({ text: `${poke.name} 使出火屬性招式，解凍了！`, cls: 'special' });
      return { skipped: false, died: false };
    }
    st.turnsLeft--;
    if (st.turnsLeft <= 0) {
      poke.status = null;
      log.push({ text: `${poke.name} 解凍了，恢復行動！`, cls: 'special' });
      return { skipped: false, died: false };
    }
    log.push({ text: `${poke.name} 被冰凍住了，無法行動！（剩 ${st.turnsLeft} 回合）`, cls: 'special' });
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

  /* Poison/burn no longer resolve here — they never blocked the attempt to begin with, and their
     damage is applied once at the very end of the turn (see applyEndOfTurnStatusSrv below), after
     whichever action (attack or standby) actually happened, matching mainline Pokémon timing
     instead of killing a Pokémon before it gets to act. */
  return { skipped: false, died: false };
}

// Applies poison/burn damage at the END of a turn — called after the turn's action (attack
// landing, being blocked by sleep/paralysis/freeze, or standby) has already resolved. Mutates
// poke.cur directly; caller is responsible for checking poke.cur <= 0 afterward.
function applyEndOfTurnStatusSrv(poke, log, G, role) {
  const st = poke.status;
  if (!st || (st.type !== 'poison' && st.type !== 'burn')) return;
  const ability = (role && isAbilitySealedSrv(role, G)) ? null : poke.ability; // 封印特性中視為沒有特性
  if (ability?.id === 'magic-guard') {
    log.push({ text: `${poke.name} 的魔法防守抵消了${st.type === 'poison' ? '中毒' : '燒傷'}傷害！`, cls: 'special' });
    return;
  }
  if (st.type === 'poison' && ability?.id === 'poison-heal' && !(role && isHealSealedSrv(role, G))) {
    const heal = Math.max(1, Math.floor(poke.hp / 8));
    poke.cur = Math.min(poke.hp, poke.cur + heal);
    log.push({ text: `${poke.name} 的毒療發動，中毒回復了 ${heal} HP！`, cls: 'special' });
    return;
  }
  // 劇毒領域場地啟用時，中毒傷害×2（2026-07-22場地卡全面加強）
  const toxicFieldActive = G?.activeStadium?.id === 'stadium-toxic-field';
  const dmg = st.type === 'poison' ? Math.max(1, Math.floor(poke.hp / 8 * (toxicFieldActive ? 2 : 1))) : Math.max(1, Math.floor(poke.hp / 16));
  const label = st.type === 'poison' ? '中毒' : '燒傷';
  poke.cur = Math.max(0, poke.cur - dmg);
  log.push({ text: `${poke.name} 因${label}損失了 ${dmg} HP！`, cls: 'special' });
}

// Decrements sleep/freeze/confusion duration on a turn where the Pokémon didn't attempt to
// attack (standby) — no attack-blocking or confusion self-hit here, those only apply when
// actually trying to attack (see handleStatus).
function tickNonAttackStatusSrv(poke, log) {
  const st = poke.status;
  if (!st || (st.type !== 'sleep' && st.type !== 'freeze' && st.type !== 'confusion')) return;
  st.turnsLeft--;
  if (st.turnsLeft <= 0) {
    poke.status = null;
    const msg = st.type === 'sleep' ? '從睡眠中醒來了！' : st.type === 'freeze' ? '解凍了，恢復行動！' : '從混亂中恢復了！';
    log.push({ text: `${poke.name} ${msg}`, cls: 'special' });
  }
}

// Executes attack and mutates defender/buffs. Returns { damage, mult }.
function doAttack(attacker, defender, atk, aBuff, dBuff, log, G, switchGuardMult = 1) {
  const atkType   = aBuff.typeOverride || atk.type;
  const burnMult  = attacker.status?.type === 'burn' ? 0.94 : 1;
  // aRole/dRole moved up from further down (identity-comparison only, doesn't depend on anything
  // computed later) so the early-return immunity branches below can also respect 封印特性.
  const aRole = aBuff === G.p1Buff ? 'p1' : 'p2';
  const dRole = dBuff === G.p1Buff ? 'p1' : 'p2';
  // 封印特性卡生效中的那一側，特性視為不存在——後面整個function一律讀attackerAbility/defenderAbility
  // 這兩個local變數，不要直接讀attacker.ability/defender.ability（那樣會繞過封印判定）
  const attackerAbility = isAbilitySealedSrv(aRole, G) ? null : attacker.ability;
  const defenderAbility = isAbilitySealedSrv(dRole, G) ? null : defender.ability;

  // Reflect mirror: bounce damage back to attacker
  if (dBuff.reflect) {
    dBuff.reflect = false;
    const rawMult = compressMult(srvEff(atkType, attacker.type));
    const dmg     = Math.max(1, Math.floor((atk.dmg + aBuff.atkBonus) * aBuff.atkMult * burnMult * (rawMult || 1)));
    attacker.cur  = Math.max(0, attacker.cur - dmg);
    log.push({ text: `反彈鏡！攻擊被反彈，${attacker.name} 承受了 ${dmg} 傷害！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFree = false; aBuff.costHalved = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: dmg, mult: 1 };
  }

  /* Water Absorb: full immunity to water-type moves, heals instead
     （詛咒生效中：免疫依然有效，但回血部分被封印） */
  if (defenderAbility?.id === 'water-absorb' && atkType === 'water') {
    const dHealSealed = isHealSealedSrv(dRole, G);
    const heal = dHealSealed ? 0 : Math.floor(defender.hp / 4);
    const actualHeal = dHealSealed ? 0 : Math.min(heal, defender.hp - defender.cur);
    defender.cur = Math.min(defender.hp, defender.cur + heal);
    log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });
    log.push(dHealSealed
      ? { text: `${defender.name} 的儲水吸收了攻擊，但恢復效果被詛咒封印中，沒有回復 HP！`, cls: 'special' }
      : { text: `${defender.name} 的儲水吸收了攻擊，回復了 ${actualHeal} HP！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFree = false; aBuff.costHalved = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }

  /* Motor Drive: full immunity to electric-type moves, gains energy instead */
  if (defenderAbility?.id === 'motor-drive' && atkType === 'electric') {
    G[`${dRole}Energy`] = Math.min(20, (G[`${dRole}Energy`] || 0) + 3);
    log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });
    log.push({ text: `${defender.name} 的電氣引擎吸收了攻擊，回復了 3 點能量！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFree = false; aBuff.costHalved = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }

  /* Flash Fire: full immunity to fire-type moves, boosts own next attack instead */
  if (defenderAbility?.id === 'flash-fire' && atkType === 'fire') {
    dBuff.atkBonus += 20;
    log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });
    log.push({ text: `${defender.name} 的引火吸收了攻擊，下次攻擊威力提升！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFree = false; aBuff.costHalved = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }

  let mult = srvEffActive(atkType, defender.type, defender.type2, G);
  // 破格系特性：既有的mold-breaker（Mega限定）+ true-damage（不動如山，攻擊無視對方防禦特性/閃避/撐住）共用同一個布林
  const moldBreaker = attackerAbility?.id === 'mold-breaker' || attackerAbility?.id === 'true-damage';
  // 深淵支配：不會受到超效傷害（型效乘數封頂在1，只降不升，不影響自己剋制對方時的正常效果）
  if (!moldBreaker && defenderAbility?.id === 'no-weakness-dodge') mult = Math.min(mult, 1);
  // 屬性轉換 (type-orb) makes the overridden type count as own for STAB purposes — pure upside.
  const isOwnType = aBuff.typeOverride ? true : (atkType === attacker.type || (attacker.type2 && atkType === attacker.type2));
  const isAdaptability = isOwnType && attackerAbility?.id === 'adaptability';
  const stabMult = isOwnType ? (isAdaptability ? 1.2 : 1.1) : 1;
  // 2026-07-22應使用者要求「場地卡全面加強，成為對戰核心策略」，16張場地卡數值全面上調
  const stadiumBonus = G?.activeStadium?.id === 'stadium-training' ? 45 : 0;
  const reversalBonus = G?.activeStadium?.id === 'stadium-reversal' && attacker.cur <= attacker.hp * 0.5 ? 65 : 0;
  const dragonValleyBonus = G?.activeStadium?.id === 'stadium-dragon-valley' && atkType === 'dragon' ? 35 : 0;
  const lowHpSelf = attacker.cur <= attacker.hp / 3;
  const halfHpSelf = attacker.cur <= attacker.hp / 2;
  const tintedLensProc = attackerAbility?.id === 'tinted-lens' && mult > 0 && mult < 1;
  const tintedLensMult = tintedLensProc ? (1 / mult) : 1; // cancels out resisted (but not immune) hits
  // 米立龍系特性「指揮」：上一隻我方寶可夢離場時留下的一次性buff，被這次攻擊消耗（能量折扣在attack handler處理，這裡只處理傷害）
  const legacyBuff = G[`${aRole}LegacyBuff`];
  // 2026-07-22應使用者要求：原本是×1.02倍率，跟下面一整批弱倍率特性一起改成固定+40傷害
  const legacyDmgBonus = legacyBuff ? 40 : 0;
  if (legacyBuff) G[`${aRole}LegacyBuff`] = null;
  // 以下弱倍率特性（原本1.02~1.06）全部改成固定+40傷害；仍≥1.1的（猛火/技術高手）維持原本倍率寫法不變
  const abilityDmgBonus = (attackerAbility?.id === 'guts' && attacker.status) ? 40
    : (attackerAbility?.id === 'huge-power') ? 40
    : (attackerAbility?.id === 'tough-claws') ? 40
    : (attackerAbility?.id === 'desperate-blade' && halfHpSelf) ? 40
    : (attackerAbility?.id === 'status-immune-once' && attacker._temperedHeart) ? 40
    : (attackerAbility?.id === 'item-synergy' && G[`${aRole}UsedItemThisTurn`]) ? 40
    : (attackerAbility?.id === 'drizzle-ocean' && (atkType === 'water' || atkType === 'ice')) ? 40
    : (attackerAbility?.id === 'drought-lava' && (atkType === 'ground' || atkType === 'fire')) ? 40
    : (DOMAIN_ABILITY_STADIUM[attackerAbility?.id]?.type === atkType) ? 40
    : 0;
  const abilityDmgMult = ((attackerAbility?.id === 'blaze-boost' && lowHpSelf && isOwnType) ? 1.1
    : (attackerAbility?.id === 'technician' && atk.dmg <= 60) ? 1.1
    : 1) * tintedLensMult;
  const thickFatMult  = (!moldBreaker && defenderAbility?.id === 'thick-fat' && (atkType === 'fire' || atkType === 'ice')) ? 0.92 : 1;
  const solidRockMult = (!moldBreaker && defenderAbility?.id === 'solid-rock' && mult >= 1.2) ? 0.95 : 1;
  const friskWardProc = !moldBreaker && defenderAbility?.id === 'frisk-ward' && Math.random() < 0.25;
  const friskWardMult = friskWardProc ? 0.9 : 1;
  const wasFullHp = defender.cur === defender.hp;
  const multiscaleMult = (!moldBreaker && defenderAbility?.id === 'multiscale' && wasFullHp) ? 0.9 : 1;
  const defAbilityMult = thickFatMult * solidRockMult * friskWardMult * multiscaleMult;
  // 2026-07-22應使用者要求：Mega進化通用加成原本×1.02，改成固定+40傷害
  const megaBoostBonus = attacker.megaEvolved ? 40 : 0;
  const colosseumMult = (G.activeStadium?.id === 'stadium-colosseum' && atkType === 'fighting') ? 1.4 : 1;
  const mysticSpaceMult = (G.activeStadium?.id === 'stadium-mystic-space' && (defender.type === 'psychic' || defender.type2 === 'psychic')) ? 0.75 : 1;
  // Lava Volcano: fire-type moves固定加成；water-type moves ×0.65（削弱，這次一起加大幅度）
  const lavaBonus = (G.activeStadium?.id === 'stadium-lava' && atkType === 'fire') ? 75 : 0;
  const lavaMult = (G.activeStadium?.id === 'stadium-lava' && atkType === 'water') ? 0.65 : 1;
  const oceanMult = (G.activeStadium?.id === 'stadium-ocean' && atkType === 'electric') ? 1.4 : 1;
  // 岩石地帶：岩石／地面／鋼屬性寶可夢，受到攻擊固定減傷150（2026-07-22場地卡全面加強，從-80再放大）
  const rockFieldReduction = (G.activeStadium?.id === 'stadium-rock-field' &&
    (['rock','ground','steel'].includes(defender.type) || ['rock','ground','steel'].includes(defender.type2))) ? 150 : 0;
  // 反轉世界：反轉後如果仍然是「克制」（mult>1），額外+25固定傷害
  const invertBonus = (G.activeStadium?.id === 'stadium-invert' && mult > 1) ? 25 : 0;
  const stadiumMult = colosseumMult * mysticSpaceMult * lavaMult * oceanMult;
  const stadiumFlatBonus = stadiumBonus + reversalBonus + lavaBonus + dragonValleyBonus + invertBonus;
  // 龍之波動／順風：只在下次攻擊剛好符合指定屬性時才加成，不論有沒有命中屬性都會被這次攻擊消耗掉
  // typeBoost可以是倍率(mult，≥1.1維持原寫法)或固定加成(bonus，2026-07-22起<1.1的一律改成這種)
  const typeBoostMatch = aBuff.typeBoost && atkType === aBuff.typeBoost.type;
  const typeBoostMult = typeBoostMatch && aBuff.typeBoost.mult ? aBuff.typeBoost.mult : 1;
  const typeBoostBonus = typeBoostMatch && aBuff.typeBoost.bonus ? aBuff.typeBoost.bonus : 0;
  // 冰凍護甲：對方這次攻擊若剛好是冰屬性，無視前面所有計算直接完全無效（比一般shield更強的針對性防禦）
  const frostArmorProc = !!dBuff.iceImmune && atkType === 'ice';
  let damage;
  if (mult === 0) {
    damage = 0;
    log.push({ text: `${atk.name} 對 ${defender.name} 完全無效！`, cls: 'resist' });
  } else if (frostArmorProc) {
    damage = 0;
    log.push({ text: `${defender.name} 的冰凍護甲抵擋了冰屬性攻擊，完全無效！`, cls: 'special' });
  } else {
    // 烈空坐系特性「威壓氣場」：對手的攻擊力提升效果（atkMult超過1的部分）減半，只影響防守方是這隻寶可夢的情況
    const effectiveAtkMult = defenderAbility?.id === 'weaken-buffs' ? (1 + Math.max(0, aBuff.atkMult - 1) * 0.5) : aBuff.atkMult;
    // 烏賊王「顛倒之心」：對手的防禦加成（shield）對它反而變成傷害加成
    // 直搗黃龍：無視對方的shield（受傷減少）效果，這次攻擊當它不存在
    const shieldTerm = aBuff.ignoreShield ? 0 : (defenderAbility?.id === 'shield-invert' ? -dBuff.shield : dBuff.shield);
    damage = Math.max(1, Math.floor((atk.dmg + aBuff.atkBonus + stadiumFlatBonus + legacyDmgBonus + abilityDmgBonus + megaBoostBonus + typeBoostBonus) * effectiveAtkMult * burnMult * mult * stabMult * switchGuardMult * abilityDmgMult * defAbilityMult * stadiumMult * typeBoostMult) - shieldTerm - rockFieldReduction);
    // 影舞：下一次受到攻擊擲硬幣，正面完全免傷——一次性旗標，這次攻擊到來就消耗掉（不論正反面）。true-damage系特性無視此效果。
    if (!moldBreaker && G[`${dRole}CoinShield`]) {
      G[`${dRole}CoinShield`] = false;
      if (Math.random() < 0.5) {
        damage = 0;
        log.push({ text: `${defender.name} 的影舞擲出硬幣正面，完全閃避了攻擊！`, cls: 'special' });
      }
    }
    // 深淵支配：被動10%機率完全閃避攻擊（每次受擊都會骰，不是一次性旗標）。true-damage系特性無視此效果。
    if (!moldBreaker && damage > 0 && defenderAbility?.id === 'no-weakness-dodge' && Math.random() < 0.1) {
      damage = 0;
      log.push({ text: `${defender.name} 的深淵支配發動，完全閃避了攻擊！`, cls: 'special' });
    }
    defender.cur = Math.max(0, defender.cur - damage);
    if (!moldBreaker && defenderAbility?.id === 'sturdy' && wasFullHp && defender.cur <= 0) {
      defender.cur = 1;
      log.push({ text: `${defender.name} 靠著頑強保住了 1 HP！`, cls: 'special' });
    }
    // 撐住：任何血量都會發動，下一次受到攻擊時（不論是否致命）就消耗掉這個一次性旗標。true-damage系特性無視此效果（不消耗旗標）。
    if (!moldBreaker && damage > 0 && G[`${dRole}Braced`]) {
      G[`${dRole}Braced`] = false;
      if (defender.cur <= 0) {
        defender.cur = 1;
        log.push({ text: `${defender.name} 靠著撐住保住了 1 HP！`, cls: 'special' });
      }
    }

    if (damage > 0) {
      let megaGain = Math.max(1, Math.round(damage / 25));
      if (atk.megaBoost) megaGain *= 2;
      if (!G[`${aRole}MegaUsed`]) G[`${aRole}MegaEnergy`] = Math.min(20, G[`${aRole}MegaEnergy`] + megaGain);
    }

    if (isAdaptability)  log.push({ text: `${attacker.name} 的適應力發動！屬性加成提升為 ×1.2！`, cls: 'super' });
    else if (stabMult > 1) log.push({ text: `屬性加成！×1.1`, cls: 'super' });
    if (attackerAbility?.id === 'guts' && attacker.status) log.push({ text: `${attacker.name} 的堅韌發動，攻擊威力提升！`, cls: 'super' });
    if (attackerAbility?.id === 'huge-power') log.push({ text: `${attacker.name} 的大力士發動，攻擊威力提升！`, cls: 'super' });
    if (attackerAbility?.id === 'blaze-boost' && lowHpSelf && isOwnType) log.push({ text: `${attacker.name} 瀕危爆發，本系招式威力大幅提升！`, cls: 'super' });
    if (attackerAbility?.id === 'tough-claws') log.push({ text: `${attacker.name} 的硬爪發動，攻擊威力提升！`, cls: 'super' });
    if (attackerAbility?.id === 'technician' && atk.dmg <= 60) log.push({ text: `${attacker.name} 的技術高手發動，攻擊威力提升！`, cls: 'super' });
    if (attackerAbility?.id === 'desperate-blade' && halfHpSelf) log.push({ text: `${attacker.name} 的${attackerAbility.name}發動，攻擊威力提升！`, cls: 'super' });
    if (moldBreaker && defenderAbility && ['thick-fat','solid-rock','frisk-ward','multiscale','sturdy'].includes(defenderAbility.id)) log.push({ text: `${attacker.name} 的破格無視了${defender.name}的特性！`, cls: 'super' });
    if (tintedLensProc) log.push({ text: `${attacker.name} 的有色眼鏡發動，抵消了效果不佳！`, cls: 'super' });
    if (thickFatMult < 1) log.push({ text: `${defender.name} 的厚脂肪減輕了傷害！`, cls: 'special' });
    if (solidRockMult < 1) log.push({ text: `${defender.name} 的硬岩減輕了剋制傷害！`, cls: 'special' });
    if (friskWardProc) log.push({ text: `${defender.name} 的神秘之守發動，傷害降低！`, cls: 'special' });
    if (multiscaleMult < 1) log.push({ text: `${defender.name} 的多重鱗片發動，HP全滿時傷害降低！`, cls: 'special' });
    if (mult >= 1.6)        log.push({ text: `超超級有效！(×${mult})`, cls: 'super' });
    else if (mult >= 1.2)   log.push({ text: `超級有效！(×${mult})`, cls: 'super' });
    else if (mult > 0 && mult < 1) log.push({ text: `效果不佳…(×${mult})`, cls: 'resist' });
    log.push({ text: `${attacker.name} 使用了 ${atk.name}，造成 ${damage} 傷害！`, cls: 'attack' });

    // Fire thaws freeze
    if (damage > 0 && atkType === 'fire' && defender.status?.type === 'freeze') {
      defender.status = null;
      log.push({ text: `被火焰融化，${defender.name} 從結凍中解脫！`, cls: 'special' });
    }
    // Inflict status — wrapped so 連擊 (double-strike) can roll it a second time
    const rollStatus = () => {
      // 妖精結界：接下來N回合，我方上場寶可夢免疫異常狀態
      if (damage > 0 && atk.status && !defender.status && defender.cur > 0 && G[`${dRole}StatusImmuneTurns`] > 0) {
        log.push({ text: `${defender.name} 的妖精結界抵擋了異常狀態！`, cls: 'special' });
        return;
      }
      if (damage > 0 && atk.status && !defender.status && defender.cur > 0 && defenderAbility?.id === 'status-immune-once' && !defender._temperedHeart) {
        defender._temperedHeart = true;
        log.push({ text: `${defender.name} 的淬鍊之心發動，免疫了異常狀態並提升了攻擊力！`, cls: 'special' });
        return;
      }
      // 心靈感應：下次攻擊的異常狀態機率視為 100%
      if (damage > 0 && atk.status && !defender.status && defender.cur > 0 && (aBuff.guaranteedStatus || Math.random() < atk.status.chance)) {
        const effect = atk.status.effect;
        if (effect === 'confusion' && defenderAbility?.id === 'own-tempo') {
          log.push({ text: `${defender.name} 的我行我素抵消了混亂！`, cls: 'special' });
        } else if (effect === 'sleep' && defenderAbility?.id === 'insomnia') {
          log.push({ text: `${defender.name} 的不眠抵消了睡眠！`, cls: 'special' });
        } else {
          const turnsLeft = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                          : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                          : effect === 'freeze'    ? 2
                          : 999;
          defender.status = { type: effect, turnsLeft };
          log.push({ text: `${defender.name} 陷入了${STATUS_ZH[effect]}！`, cls: 'special' });
          if (['poison','burn','paralysis'].includes(effect) && defenderAbility?.id === 'sync-status' && !attacker.status && attacker.cur > 0) {
            attacker.status = { type: effect, turnsLeft: 999 };
            log.push({ text: `${defender.name} 的同步將${STATUS_ZH[effect]}傳染給了${attacker.name}！`, cls: 'special' });
          }
        }
      }
    };
    rollStatus();
    if (aBuff.doubleStrike) rollStatus();
    if (damage > 0 && atk.selfHeal && attacker.cur > 0 && !isHealSealedSrv(aRole, G)) {
      const heal = Math.round((attacker.hp - attacker.cur) * atk.selfHeal);
      if (heal > 0) {
        attacker.cur = Math.min(attacker.hp, attacker.cur + heal);
        log.push({ text: `${attacker.name} 靠著攻擊回復了 ${heal} HP！`, cls: 'special' });
      }
    }
    if (damage > 0) triggerAttackerAbilitySrv(attacker, defender, log, dBuff, G);
    if (damage > 0) triggerDefenderAbilitySrv(defender, attacker, log, dBuff, G);
  }

  // Consume buffs
  aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFree = false; aBuff.costHalved = false; dBuff.shield = 0; dBuff.iceImmune = false;
  return { damage, mult };
}

// 輔助技能 (support moves) — 撐住/劍舞/小偷/影舞/施加負面效果/冥想/詭計/集氣
// 不進入傷害公式，扣能量、結束回合的方式跟一般攻擊完全相同，只是效果不同。跟 pokemon_battle.html 的
// executeSupportMove 邏輯一致（role/op 對應那邊的 aSide/dSide）。
function executeSupportMoveSrv(attacker, defender, atk, role, op, G, log) {
  log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });

  // 輔助技能不會真的打到對方，比照switch/skip/standby既有的清除規則——對方的反彈鏡／撐住／
  // 影舞這類「等下一次受到攻擊才觸發」的一次性效果，這回合沒被打到就該失效（原本只有那幾個
  // call site會清，用支援技能漏了，跟pokemon_battle.html的executeSupportMove同一個bug）
  G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false;

  switch (atk.effect) {
    case 'brace':
      G[`${role}Braced`] = true;
      log.push({ text: `${attacker.name} 擺出防禦姿態，下次受到攻擊不會被擊倒！`, cls: 'special' });
      break;
    case 'sword-dance': {
      const aBuff = G[`${role}Buff`];
      aBuff.atkMult = Math.max(aBuff.atkMult, 1.1);
      log.push({ text: `${attacker.name} 提升了氣勢，下次攻擊威力 ×1.1！`, cls: 'special' });
      break;
    }
    case 'thief': {
      const opHand = G[`${op}Hand`];
      const myHand = G[`${role}Hand`];
      if (opHand.length) {
        const idx = Math.floor(Math.random() * opHand.length);
        const stolen = opHand.splice(idx, 1)[0];
        myHand.push(stolen);
        log.push({ text: `${attacker.name} 搶走了對方的【${stolen.name}】！`, cls: 'special' });
        G[`${role}NeedsDiscard`] = myHand.length > 7;
      } else {
        log.push({ text: `對方沒有手牌可以搶。`, cls: 'system' });
      }
      break;
    }
    case 'shadow-dance':
      G[`${role}CoinShield`] = true;
      log.push({ text: `${attacker.name} 潛入了陰影中，下次受到攻擊有機會擲硬幣完全閃避！`, cls: 'special' });
      break;
    case 'debuff': {
      const aBuff = G[`${role}Buff`];
      const guaranteed = aBuff.guaranteedStatus;
      aBuff.guaranteedStatus = false;
      if (atk.status && !defender.status && defender.cur > 0 && G[`${op}StatusImmuneTurns`] > 0) {
        log.push({ text: `${defender.name} 的妖精結界抵擋了異常狀態！`, cls: 'special' });
        break;
      }
      if (atk.status && !defender.status && defender.cur > 0 && defender.ability?.id === 'status-immune-once' && !defender._temperedHeart) {
        defender._temperedHeart = true;
        log.push({ text: `${defender.name} 的淬鍊之心發動，免疫了異常狀態並提升了攻擊力！`, cls: 'special' });
        break;
      }
      if (atk.status && !defender.status && defender.cur > 0 && (guaranteed || Math.random() < atk.status.chance)) {
        const effect = atk.status.effect;
        if (effect === 'confusion' && defender.ability?.id === 'own-tempo') {
          log.push({ text: `${defender.name} 的我行我素抵消了混亂！`, cls: 'special' });
        } else if (effect === 'sleep' && defender.ability?.id === 'insomnia') {
          log.push({ text: `${defender.name} 的不眠抵消了睡眠！`, cls: 'special' });
        } else {
          const turnsLeft = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                          : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                          : effect === 'freeze'    ? 2
                          : 999;
          defender.status = { type: effect, turnsLeft };
          log.push({ text: `${defender.name} 陷入了${STATUS_ZH[effect]}！`, cls: 'special' });
        }
      }
      break;
    }
    case 'meditate':
      G[`${role}BonusItemDrawsNextTurn`] = (G[`${role}BonusItemDrawsNextTurn`] || 0) + 2;
      log.push({ text: `${attacker.name} 開始冥想，下回合將額外抽 2 張道具／競技場卡！`, cls: 'special' });
      break;
    case 'trick': {
      G[`${role}BonusSupporterDrawNextTurn`] = true;
      const aBuff = G[`${role}Buff`];
      // 2026-07-22應使用者要求：原本×1.02倍率太弱，改成固定+40傷害
      aBuff.atkBonus += 40;
      log.push({ text: `${attacker.name} 使出了詭計，下回合將額外抽 1 張支援者卡，下次攻擊威力 +40！`, cls: 'special' });
      break;
    }
    case 'focus-energy':
      G[`${role}BonusEnergyNextTurn`] = (G[`${role}BonusEnergyNextTurn`] || 0) + (atk.bonusEnergy || 9);
      log.push({ text: `${attacker.name} 集中精神，下回合將額外獲得 ${atk.bonusEnergy || 9} 點能量！`, cls: 'special' });
      break;
    case 'roost': {
      // 唯一「立即生效」的輔助技能，不是下回合promise-then-consume模式
      if (isHealSealedSrv(role, G)) {
        log.push({ text: `${attacker.name} 使用了羽棲，但恢復效果被詛咒封印中，沒有回復 HP！`, cls: 'special' });
        break;
      }
      const heal = Math.round(attacker.hp * 0.5);
      const actualHeal = Math.min(heal, attacker.hp - attacker.cur);
      attacker.cur = Math.min(attacker.hp, attacker.cur + heal);
      log.push({ text: `${attacker.name} 使用了羽棲，立即回復了 ${actualHeal} HP！`, cls: 'special' });
      break;
    }
  }
  // 每一種輔助技能額外都會讓下回合能量+5（跟該招式本身的效果疊加，例如集氣會變成9+5=14）
  G[`${role}BonusEnergyNextTurn`] = (G[`${role}BonusEnergyNextTurn`] || 0) + 5;
}

function triggerTrapStadiumSrv(poke, role, G, log) {
  if (!poke || poke.cur <= 0) return;
  if (G.activeStadium?.id === 'stadium-spikes') {
    const dmg = Math.max(1, Math.round(poke.hp * 0.25));
    poke.cur = Math.max(0, poke.cur - dmg); // 扣血效果應該能讓寶可夢陣亡，不該保留1HP
    log.push({ text: `${poke.name} 受到了尖峰陷阱的傷害！（-${dmg} HP）`, cls: 'special' });
  }
  if (G.activeStadium?.id === 'stadium-toxic-field' && !poke.status) {
    poke.status = { type: 'poison', turnsLeft: 999 };
    log.push({ text: `${poke.name} 踏入了劇毒領域，陷入了中毒！`, cls: 'special' });
  }
}
// Ability hooks — no-op for Pokémon without `ability` (see project memory for full list)
// `isFieldEntry=false` for in-place transforms (瘋狂博士/Mega 進化) — those never "switch in"
// from the bench, so trap stadiums (which punish entering the field) shouldn't fire for them.
// Mega 進化後招式改造：4招消耗全部壓縮到 5~7（維持原本4招的相對強弱排名），
// 傷害拉到tier對應的高傷害區間。跟 pokemon_battle.html 的同名函式邏輯一致。
const MEGA_MOVESET_BANDS = {
  1: { dmgLo: 90,  dmgHi: 105 },
  2: { dmgLo: 100, dmgHi: 120 },
  3: { dmgLo: 115, dmgHi: 140 },
};
const MEGA_MOVESET_COSTS = [5, 6, 6, 7];
function applyMegaMoveset(poke) {
  const band = MEGA_MOVESET_BANDS[poke.tier] || MEGA_MOVESET_BANDS[2];
  const order = poke.attacks.map((a, i) => i).sort((a, b) => poke.attacks[a].dmg - poke.attacks[b].dmg);
  order.forEach((moveIdx, rank) => {
    const frac = rank / (order.length - 1);
    poke.attacks[moveIdx].dmg = Math.round(band.dmgLo + (band.dmgHi - band.dmgLo) * frac);
    poke.attacks[moveIdx].cost = MEGA_MOVESET_COSTS[rank];
  });
}
// 8種「屬性領域」特性（2026-07-22新增，僅限不能Mega進化的寶可夢），pattern同drizzle-ocean/drought-lava
const DOMAIN_ABILITY_STADIUM = {
  'dragon-domain':   { stadium: 'stadium-dragon-valley', type: 'dragon' },
  'grass-domain':    { stadium: 'stadium-evil-forest',   type: 'grass' },
  'poison-domain':   { stadium: 'stadium-toxic-field',   type: 'poison' },
  'fighting-domain': { stadium: 'stadium-colosseum',     type: 'fighting' },
  'psychic-domain':  { stadium: 'stadium-mystic-space',  type: 'psychic' },
  'normal-domain':   { stadium: 'stadium-shrine',        type: 'normal' },
  'ground-domain':   { stadium: 'stadium-sandstorm',     type: 'ground' },
  'rock-domain':     { stadium: 'stadium-rock-field',    type: 'rock' },
};
function triggerOnEnterSrv(poke, role, G, log, isFieldEntry = true) {
  if (isFieldEntry) triggerTrapStadiumSrv(poke, role, G, log);
  if (!poke?.ability || isAbilitySealedSrv(role, G)) return;
  const op = role === 'p1' ? 'p2' : 'p1';
  if (poke.ability.id === 'intimidate') {
    const opBuff = G[`${op}Buff`];
    opBuff.atkMult = Math.min(opBuff.atkMult, 0.9);
    log.push({ text: `${poke.name} 的威嚇讓對方下次攻擊傷害 ×0.9！`, cls: 'special' });
  }
  if (poke.ability.id === 'pressure') {
    const drain = Math.min(3, G[`${op}Energy`] || 0);
    G[`${op}Energy`] = Math.max(0, (G[`${op}Energy`] || 0) - 3);
    log.push({ text: `${poke.name} 的壓迫感讓對方損失了 ${drain} 點能量！`, cls: 'special' });
  }
  if (poke.ability.id === 'trace') {
    const opPoke = G[`${op}Deck`]?.[G[`${op}Idx`]];
    if (opPoke?.ability) {
      poke.ability = { ...opPoke.ability };
      log.push({ text: `${poke.name} 的複製發動，變成了${opPoke.ability.name}！`, cls: 'special' });
    }
  }
  if (poke.ability.id === 'drizzle-ocean') {
    const oceanCard = TRAINERS.find(c => c.id === 'stadium-ocean');
    if (oceanCard) {
      G.activeStadium = { ...oceanCard };
      log.push({ text: `${poke.name} 的海洋支配發動，場地切換成了海洋世界！`, cls: 'special' });
    }
  }
  if (poke.ability.id === 'drought-lava') {
    const lavaCard = TRAINERS.find(c => c.id === 'stadium-lava');
    if (lavaCard) {
      G.activeStadium = { ...lavaCard };
      log.push({ text: `${poke.name} 的熔岩大地發動，場地切換成了熔岩火山！`, cls: 'special' });
    }
  }
  if (DOMAIN_ABILITY_STADIUM[poke.ability.id]) {
    const domainCard = TRAINERS.find(c => c.id === DOMAIN_ABILITY_STADIUM[poke.ability.id].stadium);
    if (domainCard) {
      G.activeStadium = { ...domainCard };
      log.push({ text: `${poke.name} 的${poke.ability.name}發動，場地切換成了${domainCard.name}！`, cls: 'special' });
    }
  }
}

// 米立龍系特性「指揮」：寶可夢離場（陣亡或被換下場）時觸發，把buff留給下一隻上場的我方寶可夢首次攻擊使用。
// 跟 triggerOnEnterSrv 的呼叫點相反、對稱——每個「寶可夢離開戰場」的地方都要呼叫這個。
function triggerOnLeaveSrv(poke, role, G, log) {
  if (!poke?.ability) return;
  if (poke.ability.id === 'legacy-boost') {
    // dmgMult原本1.02，2026-07-22應使用者要求改成固定+40傷害（doAttack裡legacyDmgBonus那段）
    G[`${role}LegacyBuff`] = { energyMult: 0.5 };
    log.push({ text: `${poke.name} 的指揮發動，下一隻上場的寶可夢首次攻擊將受益！`, cls: 'special' });
  }
}

function triggerAttackerAbilitySrv(attacker, defender, log, dBuff, G) {
  const aRole = dBuff === G.p1Buff ? 'p2' : 'p1'; // dBuff is the defender's buff, so attacker is the other role
  if (!attacker.ability || isAbilitySealedSrv(aRole, G)) return;
  if (attacker.ability.id === 'static-trail' && defender.cur > 0 && !defender.status && Math.random() < 0.15) {
    defender.status = { type: 'paralysis', turnsLeft: 999 };
    log.push({ text: `${attacker.name} 的電擊尾隨讓 ${defender.name} 陷入了麻痺！`, cls: 'special' });
  }
  if (attacker.ability.id === 'chance-debuff' && defender.cur > 0 && Math.random() < 0.25) {
    dBuff.atkMult = Math.min(dBuff.atkMult, 0.9);
    log.push({ text: `${attacker.name} 的穿透讓對方下次攻擊傷害 ×0.9！`, cls: 'special' });
  }
}

function triggerDefenderAbilitySrv(defender, attacker, log, dBuff, G) {
  const dRole = dBuff === G.p1Buff ? 'p1' : 'p2';
  if (!defender.ability || isAbilitySealedSrv(dRole, G)) return;
  if (defender.ability.id === 'static' && !attacker.status && Math.random() < 0.20) {
    attacker.status = { type: 'paralysis', turnsLeft: 999 };
    log.push({ text: `${defender.name} 的靜電讓 ${attacker.name} 陷入了麻痺！`, cls: 'special' });
  } else if (defender.ability.id === 'rough-skin') {
    const recoil = Math.max(1, Math.floor(attacker.hp / 8));
    attacker.cur = Math.max(0, attacker.cur - recoil);
    log.push({ text: `${defender.name} 的粗糙皮膚反彈了 ${recoil} 點傷害給 ${attacker.name}！`, cls: 'special' });
  } else if (defender.ability.id === 'poison-point' && !attacker.status && Math.random() < 0.20) {
    attacker.status = { type: 'poison', turnsLeft: 999 };
    log.push({ text: `${defender.name} 的毒刺讓 ${attacker.name} 陷入了中毒！`, cls: 'special' });
  } else if (defender.ability.id === 'flame-body' && !attacker.status && Math.random() < 0.20) {
    attacker.status = { type: 'burn', turnsLeft: 999 };
    log.push({ text: `${defender.name} 的火焰之軀讓 ${attacker.name} 陷入了燒傷！`, cls: 'special' });
  } else if (defender.ability.id === 'retaliate-boost' && defender.cur > 0) {
    dBuff.atkMult = Math.max(dBuff.atkMult, 1.1);
    log.push({ text: `${defender.name} 的反骨發動，下次攻擊威力提升！`, cls: 'special' });
  }
}

// Applies a trainer card effect to the given role's side.
function applyTrainer(card, role, G, log, chosenType) {
  const op     = role === 'p1' ? 'p2' : 'p1';
  const deck   = G[`${role}Deck`];
  const idx    = G[`${role}Idx`];
  const buff   = G[`${role}Buff`];
  const active = deck[idx];
  const attackTypes = Object.keys(EFF);

  switch (card.id) {
    case 'potion-m': case 'potion-l': case 'potion-xl': {
      if (isHealSealedSrv(role, G)) { log.push({ text: `使用了${card.name}，但恢復效果被詛咒封印中，沒有任何效果！`, cls: 'system' }); break; }
      const healAmt = { 'potion-m':40, 'potion-l':60, 'potion-xl':80 }[card.id];
      active.cur = Math.min(active.hp, active.cur + healAmt);
      log.push({ text: `使用了${card.name}，${active.name} 回復 ${healAmt} HP！`, cls: 'system' });
      break;
    }
    case 'x-atk':
      buff.atkBonus += 40;
      log.push({ text: `使用了攻擊強化，下次攻擊 +40 傷害！`, cls: 'system' });
      break;
    case 'x-def':
      buff.shield += 40;
      log.push({ text: `使用了防禦強化，下次承受傷害 -40！`, cls: 'system' });
      break;
    case 'energize':
      buff.atkMult *= 1.2;
      active.cur = Math.max(1, active.cur - 50);
      log.push({ text: `使用了能量強化，下次攻擊傷害 ×1.2！但 ${active.name} 損失 50 HP！`, cls: 'system' });
      break;
    case 'revive': {
      if (G[`${role}ReviveUsed`]) { log.push({ text: `復活藥每場只能使用一次，已經用過了！`, cls: 'system' }); break; }
      if (isHealSealedSrv(role, G)) { log.push({ text: `使用了${card.name}，但恢復效果被詛咒封印中，沒有任何效果！`, cls: 'system' }); break; }
      const di = deck.findIndex((p, i) => i !== idx && p.cur <= 0);
      if (di >= 0) {
        deck[di].cur = 40;
        G[`${role}ReviveUsed`] = true;
        log.push({ text: `${deck[di].name} 被復活了！`, cls: 'system' });
      } else {
        log.push({ text: `沒有可復活的寶可夢！`, cls: 'system' });
      }
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
      if (isHealSealedSrv(role, G)) {
        active.status = null;
        log.push({ text: `治療師解除了 ${active.name} 的異常狀態，但恢復效果被詛咒封印中，HP 沒有回復！`, cls: 'system' });
      } else {
        active.cur = active.hp; active.status = null;
        log.push({ text: `治療師讓 ${active.name} 完全回復！`, cls: 'system' });
      }
      break;
    case 'all-out':
      buff.atkMult *= 1.2;
      G[`${role}EnergyBlockedNextTurn`] = true;
      log.push({ text: `使用了全力出擊，下次攻擊傷害 ×1.2！但下回合無法回復能量！`, cls: 'system' });
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
    case 'confuse-potion': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (opActive.ability?.id === 'own-tempo') { log.push({ text: `${opActive.name} 的我行我素抵消了混亂藥！`, cls: 'system' }); }
      else if (!opActive.status) { opActive.status = { type: 'confusion', turnsLeft: Math.floor(Math.random()*3)+2 }; log.push({ text: `混亂藥讓 ${opActive.name} 陷入混亂！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 已有異常狀態，混亂藥無效！`, cls: 'system' });
      break;
    }
    case 'absolute-zero': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (!opActive.status) { opActive.status = { type: 'freeze', turnsLeft: 2 }; log.push({ text: `絕對零度讓 ${opActive.name} 陷入結凍！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 已有異常狀態，絕對零度無效！`, cls: 'system' });
      break;
    }
    case 'retreat-vest':
      G[`${role}FreeSwitch`] = true;
      log.push({ text: `使用了撤退背心，下次換場不會結束回合！`, cls: 'system' });
      break;
    case 'switcher': {
      const opRole    = op;
      const opDeck    = G[`${opRole}Deck`];
      const opIdx     = G[`${opRole}Idx`];
      const aliveOpts = opDeck.map((_,i)=>i).filter(i => i !== opIdx && opDeck[i].cur > 0);
      if (aliveOpts.length > 0) {
        const outPoke = opDeck[opIdx];
        const newIdx = aliveOpts[Math.floor(Math.random() * aliveOpts.length)];
        G[`${opRole}Idx`] = newIdx;
        // 強制換人，原本累積的buff（攻擊強化/反彈鏡/屬性寶珠等）全部重置——撐住/硬幣護盾是跟buff
        // 平行的獨立欄位（不在freshBuff()裡），之前漏重置，導致被交換器換下場的寶可夢下次上場
        // 還帶著撐住效果，跟其他「這回合沒實際出手」情境的清除邏輯不一致
        G[`${opRole}Buff`] = freshBuff();
        G[`${opRole}Braced`] = false;
        G[`${opRole}CoinShield`] = false;
        log.push({ text: `交換器強制換出 ${opDeck[newIdx].name} 上場！`, cls: 'special' });
        triggerOnLeaveSrv(outPoke, opRole, G, log); // forced switch is a genuine field departure for the outgoing Pokémon too
        triggerOnEnterSrv(opDeck[newIdx], opRole, G, log); // forced switch is a genuine field entry — traps/on-enter abilities must fire
      } else {
        log.push({ text: `對手沒有可換的備戰寶可夢！`, cls: 'system' });
      }
      break;
    }
    case 'reflect':
      buff.reflect = true;
      log.push({ text: `設置了反彈鏡！下次對手攻擊將反彈！`, cls: 'special' });
      break;
    case 'type-orb': {
      const chosen = attackTypes.includes(chosenType) ? chosenType : attackTypes[Math.floor(Math.random() * attackTypes.length)];
      buff.typeOverride = chosen;
      log.push({ text: `使用了屬性轉換，本回合攻擊視為${chosen}屬性（享有屬性加成）！`, cls: 'system' });
      break;
    }
    case 'hand-wreck': {
      const opHand = G[`${op}Hand`];
      if (opHand.length) {
        const wIdx = Math.floor(Math.random() * opHand.length);
        const discarded = opHand.splice(wIdx, 1)[0];
        log.push({ text: `使用了手牌破壞，對方棄掉了【${discarded.name}】！`, cls: 'system' });
      } else {
        log.push({ text: `使用了手牌破壞，但對方沒有手牌可以棄。`, cls: 'system' });
      }
      break;
    }
    case 'plunder': {
      const opHand = G[`${op}Hand`];
      const myHand = G[`${role}Hand`];
      if (opHand.length) {
        const pIdx = Math.floor(Math.random() * opHand.length);
        const stolen = opHand.splice(pIdx, 1)[0];
        myHand.push(stolen);
        log.push({ text: `使用了掠奪，搶走了對方的【${stolen.name}】！`, cls: 'system' });
        G[`${role}NeedsDiscard`] = myHand.length > 7;
      } else {
        log.push({ text: `使用了掠奪，但對方沒有手牌可以搶。`, cls: 'system' });
      }
      break;
    }
    case 'comm-seal': {
      G[`${op}SupporterLocked`] = true;
      log.push({ text: `使用了通訊封印，對方下回合無法使用支援者卡！`, cls: 'system' });
      break;
    }
    case 'paralyze-trap': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (!opActive.status) { opActive.status = { type: 'paralysis', turnsLeft: 999 }; log.push({ text: `電擊誘餌讓 ${opActive.name} 陷入麻痺！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 已有異常狀態，電擊誘餌無效！`, cls: 'system' });
      break;
    }
    case 'curse-drain': {
      const before = G[`${op}Energy`];
      G[`${op}Energy`] = Math.max(0, G[`${op}Energy`] - 8);
      const heal = Math.min(20, active.hp - active.cur);
      active.cur = Math.min(active.hp, active.cur + 20);
      log.push({ text: `使用了詛咒波動，對方損失了 ${before - G[`${op}Energy`]} 點能量，${active.name} 回復了 ${heal} HP！`, cls: 'system' });
      break;
    }
    case 'iron-guard':
      buff.shield += 70;
      log.push({ text: `使用了鋼鐵裝甲，下次承受傷害 -70！`, cls: 'system' });
      break;
    case 'night-raid': {
      const opHand = G[`${op}Hand`];
      const myHand = G[`${role}Hand`];
      const stolenNames = [];
      for (let i = 0; i < 2 && opHand.length; i++) {
        const idx2 = Math.floor(Math.random() * opHand.length);
        const stolen = opHand.splice(idx2, 1)[0];
        myHand.push(stolen);
        stolenNames.push(stolen.name);
      }
      if (stolenNames.length) log.push({ text: `使用了夜襲，搶走了對方的【${stolenNames.join('、')}】！`, cls: 'system' });
      else log.push({ text: `使用了夜襲，但對方沒有手牌可以搶。`, cls: 'system' });
      G[`${role}NeedsDiscard`] = myHand.length > 7;
      break;
    }
    case 'tailwind':
      // 2026-07-22應使用者要求：原本×1.04倍率太弱，改成固定+40傷害
      buff.typeBoost = { type: 'flying', bonus: 40 };
      log.push({ text: `使用了順風，下次攻擊若為飛行屬性，傷害 +40！`, cls: 'system' });
      break;
    case 'fairy-wind': {
      active.status = null;
      const gain = Math.min(40, active.hp - active.cur);
      active.cur = Math.min(active.hp, active.cur + 40);
      log.push({ text: `使用了妖精之光，${active.name} 解除異常狀態並回復了 ${gain} HP！`, cls: 'system' });
      break;
    }
    case 'swarm-sting': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      const before = G[`${op}Energy`];
      G[`${op}Energy`] = Math.max(0, G[`${op}Energy`] - 3);
      if (!opActive.status) { opActive.status = { type: 'poison', turnsLeft: 999 }; log.push({ text: `群聚針刺讓 ${opActive.name} 陷入中毒，並損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 已有異常狀態，群聚針刺只讓對方損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'system' });
      break;
    }
    case 'tidal-heal': {
      const heal = Math.round(active.hp * 0.3);
      const actualHeal = Math.min(heal, active.hp - active.cur);
      active.cur = Math.min(active.hp, active.cur + heal);
      log.push({ text: `使用了潮汐回復，${active.name} 回復了 ${actualHeal} HP！`, cls: 'system' });
      break;
    }
    case 'dragon-pulse':
      buff.typeBoost = { type: 'dragon', mult: 1.12 };
      log.push({ text: `使用了龍之波動，下次攻擊若為龍屬性，傷害 ×1.12！`, cls: 'system' });
      break;
    case 'focus-punch':
      // 2026-07-22應使用者要求：原本×1.04倍率太弱，改成固定+40傷害
      buff.atkBonus += 40;
      active.cur = Math.max(1, Math.round(active.cur * 0.8));
      log.push({ text: `使用了捨身猛擊，下次攻擊威力 +40！但 ${active.name} 損失了 20% 目前 HP！`, cls: 'system' });
      break;
    case 'energy-drain': {
      const opEnergyKey = `${op}Energy`;
      const before = G[opEnergyKey];
      G[opEnergyKey] = Math.max(0, G[opEnergyKey] - 6);
      log.push({ text: `使用了能量剝奪，對方損失了 ${before - G[opEnergyKey]} 點能量！`, cls: 'system' });
      break;
    }
    case 'gamble': {
      if (Math.random() < 0.3) {
        buff.atkMult = Math.max(buff.atkMult, 1.6);
        log.push({ text: `使用了一擲千金，賭贏了！下次攻擊傷害 ×1.6！`, cls: 'system' });
      } else {
        const dmgLoss = Math.round(active.hp * 0.4);
        active.cur = Math.max(1, active.cur - dmgLoss);
        log.push({ text: `使用了一擲千金，賭輸了……${active.name} 損失了 ${dmgLoss} HP！`, cls: 'system' });
      }
      break;
    }
    case 'desperate-boost': {
      const bonus = Math.round(50 * (1 - active.cur / active.hp));
      buff.atkBonus += bonus;
      log.push({ text: `使用了背水一戰，HP 越低加成越高，下次攻擊威力 +${bonus}！`, cls: 'system' });
      break;
    }
    case 'double-strike':
      // 2026-07-22應使用者要求：原本×1.08倍率太弱，改成固定+40傷害；doubleStrike(狀態機率×2)本身不受影響
      buff.atkBonus += 40;
      buff.doubleStrike = true;
      log.push({ text: `使用了連擊，下次攻擊威力 +40，並將分兩段結算！`, cls: 'system' });
      break;
    case 'energy-patch-l': {
      const gain = 4;
      const actualGain = Math.min(20 - G[`${role}Energy`], gain);
      G[`${role}Energy`] = Math.min(20, G[`${role}Energy`] + gain);
      log.push({ text: `${card.name}回復了 ${actualGain} 點能量！（現在 ${G[`${role}Energy`]}/20）`, cls: 'system' });
      break;
    }
    case 'cheerleader':
      G[`${role}Energy`] = 20;
      log.push({ text: `啦啦隊將能量補滿到 20！`, cls: 'special' });
      break;
    // ── 支援者牌：屬性分類新卡 ──
    case 'fire-nova': {
      buff.atkBonus += 60;
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (!opActive.status && Math.random() < 0.3) {
        opActive.status = { type: 'burn', turnsLeft: 999 };
        log.push({ text: `使用了${card.name}，下次攻擊威力 +60，${opActive.name} 陷入了燒傷！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，下次攻擊威力 +60！`, cls: 'system' });
      }
      break;
    }
    case 'abyssal-power':
      buff.costHalved = true;
      log.push({ text: `使用了${card.name}，下次攻擊消耗能量減半！`, cls: 'system' });
      break;
    case 'earthen-wall':
      buff.shield += 90;
      log.push({ text: `使用了${card.name}，下次承受傷害 -90！`, cls: 'system' });
      break;
    case 'lightning-dash':
      buff.costFree = true;
      log.push({ text: `使用了${card.name}，這次攻擊不消耗能量！`, cls: 'system' });
      break;
    case 'leech-seed':
      G[`${role}LeechTurns`] = 3;
      log.push({ text: `使用了${card.name}，接下來 3 回合，每回合開始都會吸取對方 3 點能量！`, cls: 'special' });
      break;
    case 'mind-focus':
      buff.guaranteedStatus = true;
      log.push({ text: `使用了${card.name}，下次攻擊的異常狀態機率視為 100%！`, cls: 'system' });
      break;
    case 'breakthrough':
      buff.atkBonus += 40;
      buff.ignoreShield = true;
      log.push({ text: `使用了${card.name}，下次攻擊威力 +40，且無視對方的受傷減少效果！`, cls: 'system' });
      break;
    case 'ability-seal': {
      G[`${op}AbilitySealedTurns`] = 2;
      log.push({ text: `使用了${card.name}，封印了對方的特性 2 回合！`, cls: 'special' });
      break;
    }
    case 'heal-seal': {
      G[`${op}HealSealedTurns`] = 2;
      log.push({ text: `使用了${card.name}，讓對方的恢復效果 2 回合內全部失效！`, cls: 'special' });
      break;
    }
    case 'wraith-curse': {
      G[`${op}MegaSealedTurns`] = 2;
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 5);
      log.push({ text: `使用了${card.name}，封印對方 Mega 進化 2 回合，並讓對方損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' });
      break;
    }
    case 'dragon-might': {
      buff.atkMult = Math.max(buff.atkMult, 1.5);
      const loss = Math.round(active.hp * 0.25);
      active.cur = Math.max(1, active.cur - loss);
      log.push({ text: `使用了${card.name}，${active.name} 損失了 25% 最大HP，下次攻擊威力 ×1.5！（剩 ${active.cur}/${active.hp}）`, cls: 'system' });
      break;
    }
    case 'steel-fortress':
      buff.shield += 100;
      log.push({ text: `使用了${card.name}，下次承受傷害 -100！`, cls: 'system' });
      break;
    case 'frost-armor':
      buff.shield += 60;
      buff.iceImmune = true;
      log.push({ text: `使用了${card.name}，下次承受傷害 -60；若對方使用冰屬性攻擊則完全無效！`, cls: 'system' });
      break;
    case 'quick-thinking': {
      const hand = G[`${role}Hand`];
      const itemsOnly = getDrawPool(active.type, active.type2);
      const drawn = [weightedPick(itemsOnly), weightedPick(itemsOnly)];
      hand.push(...drawn);
      log.push({ text: `使用了${card.name}，抽到了：${drawn.map(c => c.name).join('、')}！`, cls: 'system' });
      G[`${role}NeedsDiscard`] = hand.length > 7;
      break;
    }
    case 'shadow-lockdown': {
      G[`${op}MegaSealedTurns`] = 2;
      const opHand = G[`${op}Hand`];
      if (opHand.length) {
        const wIdx = Math.floor(Math.random() * opHand.length);
        const discarded = opHand.splice(wIdx, 1)[0];
        log.push({ text: `使用了${card.name}，封印對方 Mega 進化 2 回合，並讓對方棄掉了【${discarded.name}】！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，封印對方 Mega 進化 2 回合，但對方沒有手牌可以棄。`, cls: 'system' });
      }
      break;
    }
    case 'gale-dodge':
      G[`${role}CoinShield`] = true;
      log.push({ text: `使用了${card.name}，下次受到攻擊有機會擲硬幣完全迴避！`, cls: 'system' });
      break;
    case 'tectonic-shift':
      if (G.activeStadium) {
        log.push({ text: `使用了${card.name}，清除了競技場【${G.activeStadium.name}】的效果！`, cls: 'special' });
        G.activeStadium = null;
      } else {
        log.push({ text: `使用了${card.name}，但目前沒有競技場效果。`, cls: 'system' });
      }
      break;
    case 'fairy-barrier':
      G[`${role}StatusImmuneTurns`] = 2;
      log.push({ text: `使用了${card.name}，接下來 2 回合，我方上場寶可夢免疫異常狀態！`, cls: 'special' });
      break;
    case 'toxic-pact': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 10);
      if (!opActive.status) {
        opActive.status = { type: 'poison', turnsLeft: 999 };
        log.push({ text: `使用了${card.name}，讓${opActive.name} 陷入中毒，並損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，${opActive.name} 已有異常狀態，只損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'system' });
      }
      break;
    }
    case 'swarm-feast': {
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 8);
      const drained = before - G[`${op}Energy`];
      const transfer = Math.min(4, drained);
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + transfer);
      log.push({ text: `使用了${card.name}，對方損失了 ${drained} 點能量，自己獲得了 ${transfer} 點能量！`, cls: 'special' });
      break;
    }
    // ── 支援者牌屬性分類新卡 第二批 ──
    case 'fire-fury': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (opActive.status) {
        buff.atkBonus += 70;
        log.push({ text: `使用了${card.name}，對手已有異常狀態，下次攻擊威力 +70！`, cls: 'special' });
      } else {
        buff.atkBonus += 25;
        log.push({ text: `使用了${card.name}，下次攻擊威力 +25！`, cls: 'special' });
      }
      break;
    }
    case 'fire-resolve':
      G[`${role}Energy`] = Math.max(0, (G[`${role}Energy`] || 0) - 15);
      buff.atkMult = Math.max(buff.atkMult, 1.3);
      log.push({ text: `使用了${card.name}，損失 15 點能量，下次攻擊威力 ×1.3！`, cls: 'special' });
      break;
    case 'water-recover':
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 8);
      log.push({ text: `使用了${card.name}，回復了 8 點能量！`, cls: 'special' });
      break;
    case 'water-aegis':
      buff.shield += 50;
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 3);
      log.push({ text: `使用了${card.name}，下次承受傷害 -50，並回復了 3 點能量！`, cls: 'special' });
      break;
    case 'ground-heal': {
      const heal = Math.round(active.hp * 0.15);
      const gain = Math.min(active.hp - active.cur, heal);
      active.cur = Math.min(active.hp, active.cur + heal);
      log.push({ text: `使用了${card.name}，${active.name} 回復了 ${gain} HP！（現在 ${active.cur}/${active.hp}）`, cls: 'special' });
      break;
    }
    case 'ground-bulwark': {
      const opBuff = G[`${op}Buff`];
      buff.shield += 70;
      opBuff.atkMult = Math.min(opBuff.atkMult, 0.9);
      log.push({ text: `使用了${card.name}，下次承受傷害 -70，並讓對手下次攻擊威力 ×0.9！`, cls: 'special' });
      break;
    }
    case 'electric-charge':
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 10);
      log.push({ text: `使用了${card.name}，回復了 10 點能量！`, cls: 'special' });
      break;
    case 'electric-chain': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (!opActive.status && Math.random() < 0.4) {
        opActive.status = { type: 'paralysis', turnsLeft: 999 };
        log.push({ text: `使用了${card.name}，${opActive.name} 陷入了麻痺！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，但沒有觸發效果。`, cls: 'system' });
      }
      break;
    }
    case 'grass-bind': {
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 6);
      log.push({ text: `使用了${card.name}，對方損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' });
      break;
    }
    case 'grass-photosyn':
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 10);
      if (active.cur <= active.hp * 0.5) {
        const gain = Math.min(active.hp - active.cur, 8);
        active.cur = Math.min(active.hp, active.cur + gain);
        log.push({ text: `使用了${card.name}，回復了 10 點能量，並額外回復了 ${gain} HP！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，回復了 10 點能量！`, cls: 'special' });
      }
      break;
    case 'psychic-disrupt': {
      const opHand = G[`${op}Hand`];
      if (opHand.length) {
        const wIdx = Math.floor(Math.random() * opHand.length);
        const discarded = opHand.splice(wIdx, 1)[0];
        log.push({ text: `使用了${card.name}，讓對方棄掉了【${discarded.name}】！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，但對方沒有手牌可以棄。`, cls: 'system' });
      }
      break;
    }
    case 'psychic-foresight': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (opActive.status) {
        buff.atkBonus += 80;
        log.push({ text: `使用了${card.name}，對手已有異常狀態，下次攻擊威力 +80！`, cls: 'special' });
      } else {
        buff.atkBonus += 50;
        log.push({ text: `使用了${card.name}，下次攻擊威力 +50！`, cls: 'special' });
      }
      break;
    }
    case 'fighting-crush': {
      const opBuff = G[`${op}Buff`];
      if (opBuff.shield > 0) {
        buff.atkBonus += 90;
        log.push({ text: `使用了${card.name}，對手持有防禦加成，下次攻擊威力 +90！`, cls: 'special' });
      } else {
        buff.atkBonus += 60;
        log.push({ text: `使用了${card.name}，下次攻擊威力 +60！`, cls: 'special' });
      }
      break;
    }
    case 'fighting-ironfist': {
      const opBuff = G[`${op}Buff`];
      opBuff.atkMult = Math.min(opBuff.atkMult, 0.85);
      log.push({ text: `使用了${card.name}，讓對手下次攻擊威力 ×0.85！`, cls: 'special' });
      break;
    }
    case 'ghost-drain': {
      const opHand = G[`${op}Hand`];
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 8);
      if (opHand.length) {
        const wIdx = Math.floor(Math.random() * opHand.length);
        const discarded = opHand.splice(wIdx, 1)[0];
        log.push({ text: `使用了${card.name}，對方損失了 ${before - G[`${op}Energy`]} 點能量，並棄掉了【${discarded.name}】！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，對方損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' });
      }
      break;
    }
    case 'ghost-obsession': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      buff.guaranteedStatus = true;
      if (opActive.megaEvolved) {
        buff.atkBonus += 40;
        log.push({ text: `使用了${card.name}，下次攻擊異常狀態機率 100%，對手為 Mega 型態，威力額外 +40！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，下次攻擊異常狀態機率視為 100%！`, cls: 'special' });
      }
      break;
    }
    case 'dragon-fang':
      G[`${role}Energy`] = Math.max(0, (G[`${role}Energy`] || 0) - 10);
      buff.atkBonus += 90;
      log.push({ text: `使用了${card.name}，損失 10 點能量，下次攻擊威力 +90！`, cls: 'special' });
      break;
    case 'dragon-cleanse': {
      if (active.status) {
        const st = STATUS_ZH[active.status.type] || active.status.type;
        active.status = null;
        log.push({ text: `使用了${card.name}，解除了 ${active.name} 的${st}！`, cls: 'special' });
      }
      const gain = Math.min(active.hp - active.cur, 5);
      active.cur = Math.min(active.hp, active.cur + gain);
      break;
    }
    case 'steel-resolve':
      buff.shield += 50;
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 5);
      log.push({ text: `使用了${card.name}，下次承受傷害 -50，並回復了 5 點能量！`, cls: 'special' });
      break;
    case 'steel-flash': {
      const opBuff = G[`${op}Buff`];
      buff.shield += 40;
      opBuff.atkMult = Math.min(opBuff.atkMult, 0.9);
      log.push({ text: `使用了${card.name}，下次承受傷害 -40，並讓對手下次攻擊威力 ×0.9！`, cls: 'special' });
      break;
    }
    case 'ice-howl': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (!opActive.status && Math.random() < 0.35) {
        opActive.status = { type: 'freeze', turnsLeft: 2 };
        log.push({ text: `使用了${card.name}，${opActive.name} 陷入了結凍！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，但沒有觸發效果。`, cls: 'system' });
      }
      break;
    }
    case 'ice-barrier':
      buff.shield += 40;
      G[`${role}StatusImmuneTurns`] = Math.max(G[`${role}StatusImmuneTurns`] || 0, 1);
      log.push({ text: `使用了${card.name}，下次承受傷害 -40，接下來 1 回合免疫異常狀態！`, cls: 'special' });
      break;
    case 'normal-allout':
      buff.atkBonus += 35;
      buff.costFree = true;
      log.push({ text: `使用了${card.name}，下次攻擊威力 +35，且不消耗能量！`, cls: 'special' });
      break;
    case 'normal-refresh': {
      const hand = G[`${role}Hand`];
      const itemsOnly = getDrawPool(active.type, active.type2);
      const drawn = weightedPick(itemsOnly);
      hand.push(drawn);
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 4);
      log.push({ text: `使用了${card.name}，抽到了【${drawn.name}】，並回復了 4 點能量！`, cls: 'special' });
      G[`${role}NeedsDiscard`] = hand.length > 7;
      break;
    }
    case 'dark-heist': {
      const opHand = G[`${op}Hand`];
      const myHand = G[`${role}Hand`];
      if (opHand.length) {
        const wIdx = Math.floor(Math.random() * opHand.length);
        const stolen = opHand.splice(wIdx, 1)[0];
        myHand.push(stolen);
        log.push({ text: `使用了${card.name}，搶走了對方的【${stolen.name}】！`, cls: 'special' });
        G[`${role}NeedsDiscard`] = myHand.length > 7;
      } else {
        log.push({ text: `使用了${card.name}，但對方沒有手牌可以搶。`, cls: 'system' });
      }
      break;
    }
    case 'dark-ambush': {
      const opBuff = G[`${op}Buff`];
      buff.atkBonus += 50;
      opBuff.atkMult = Math.min(opBuff.atkMult, 0.9);
      log.push({ text: `使用了${card.name}，下次攻擊威力 +50，並讓對手下次攻擊威力 ×0.9！`, cls: 'special' });
      break;
    }
    case 'flying-dance':
      buff.atkMult = Math.max(buff.atkMult, 1.2);
      buff.shield += 30;
      log.push({ text: `使用了${card.name}，下次攻擊威力 ×1.2，且下次承受傷害 -30！`, cls: 'special' });
      break;
    case 'flying-gale': {
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 8);
      log.push({ text: `使用了${card.name}，對方損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' });
      break;
    }
    case 'rock-slide':
      if (G.activeStadium) {
        buff.atkBonus += 80;
        log.push({ text: `使用了${card.name}，場上有競技場效果，下次攻擊威力 +80！`, cls: 'special' });
      } else {
        buff.atkBonus += 55;
        log.push({ text: `使用了${card.name}，下次攻擊威力 +55！`, cls: 'special' });
      }
      break;
    case 'rock-fortress':
      buff.shield += 60;
      log.push({ text: `使用了${card.name}，下次承受傷害 -60！`, cls: 'special' });
      break;
    case 'fairy-song': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (opActive.ability?.id === 'own-tempo') {
        log.push({ text: `${opActive.name} 的我行我素抵消了${card.name}！`, cls: 'special' });
      } else if (!opActive.status && Math.random() < 0.3) {
        opActive.status = { type: 'confusion', turnsLeft: Math.floor(Math.random() * 3) + 2 };
        log.push({ text: `使用了${card.name}，${opActive.name} 陷入了混亂！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，但沒有觸發效果。`, cls: 'system' });
      }
      break;
    }
    case 'fairy-heal': {
      if (active.status) {
        const st = STATUS_ZH[active.status.type] || active.status.type;
        active.status = null;
        log.push({ text: `使用了${card.name}，解除了 ${active.name} 的${st}！`, cls: 'special' });
      }
      const gain = Math.min(active.hp - active.cur, 10);
      active.cur = Math.min(active.hp, active.cur + gain);
      break;
    }
    case 'poison-spore': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (!opActive.status && Math.random() < 0.5) {
        opActive.status = { type: 'poison', turnsLeft: 999 };
        log.push({ text: `使用了${card.name}，${opActive.name} 陷入了中毒！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，但沒有觸發效果。`, cls: 'system' });
      }
      break;
    }
    case 'poison-strike': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (opActive.status?.type === 'poison') {
        buff.atkBonus += 80;
        log.push({ text: `使用了${card.name}，對手已中毒，下次攻擊威力 +80！`, cls: 'special' });
      } else {
        buff.atkBonus += 40;
        log.push({ text: `使用了${card.name}，下次攻擊威力 +40！`, cls: 'special' });
      }
      break;
    }
    case 'bug-web': {
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 6);
      buff.atkBonus += 20;
      log.push({ text: `使用了${card.name}，對方損失了 ${before - G[`${op}Energy`]} 點能量，自己下次攻擊威力 +20！`, cls: 'special' });
      break;
    }
    case 'bug-swarm': {
      const hand = G[`${role}Hand`];
      const itemsOnly = getDrawPool(active.type, active.type2);
      const drawn = weightedPick(itemsOnly);
      hand.push(drawn);
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 6);
      log.push({ text: `使用了${card.name}，回復了 6 點能量，並抽到了【${drawn.name}】！`, cls: 'special' });
      G[`${role}NeedsDiscard`] = hand.length > 7;
      break;
    }
    case 'stadium-training':
    case 'stadium-spring':
    case 'stadium-reversal':
    case 'stadium-invert':
    case 'stadium-dragon-valley':
    case 'stadium-evil-forest':
    case 'stadium-mega-prism':
    case 'stadium-spikes':
    case 'stadium-toxic-field':
    case 'stadium-colosseum':
    case 'stadium-mystic-space':
    case 'stadium-lava':
    case 'stadium-ocean':
    case 'stadium-shrine':
    case 'stadium-sandstorm':
    case 'stadium-rock-field': {
      const old = G.activeStadium;
      G.activeStadium = card;
      if (old) log.push({ text: `新競技場【${card.name}】取代了【${old.name}】！`, cls: 'special' });
      else log.push({ text: `【${card.name}】競技場開場！`, cls: 'special' });
      break;
    }
  }
}

// Draws 1-2 cards for a single role at the start of their turn.
// Also applies Hot Springs healing (once per turn, for both sides).
function drawForRole(G, role) {
  // 通訊封印：把「下回合鎖定」的旗標升級成「這回合鎖定中」，並清掉原始旗標——
  // 這樣鎖定只會卡住緊接著的這一回合，之後的回合不會被誤鎖
  G[`${role}SupporterLockedThisTurn`] = G[`${role}SupporterLocked`];
  G[`${role}SupporterLocked`] = false;
  G[`${role}UsedItemThisTurn`] = false; // 龍捲雲系特性「機械之心」的旗標，每回合開始重置
  if (G.activeStadium?.id === 'stadium-spring') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur > 0 && poke.cur < poke.hp && !isHealSealedSrv(r, G)) { // 詛咒：只跳過被封印的那一側
        poke.cur = Math.min(poke.hp, poke.cur + 30);
      }
    }
  }
  if (G.activeStadium?.id === 'stadium-sandstorm') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      const immune = ['ground', 'rock', 'steel'].includes(poke.type) || ['ground', 'rock', 'steel'].includes(poke.type2);
      if (poke.cur > 0 && !immune) {
        const dmg = Math.max(1, Math.round(poke.hp * 0.12));
        poke.cur = Math.max(0, poke.cur - dmg);
      }
    }
  }
  // 全力出擊：上回合使用時「下回合無法回復能量」的代價，這裡直接跳過能量回復並清掉旗標
  if (G[`${role}EnergyBlockedNextTurn`]) {
    G[`${role}EnergyBlockedNextTurn`] = false;
  } else {
    G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 3);
  }
  // 集氣／消耗4-15的攻擊招式：上回合使用時承諾的「下回合額外能量」，這裡兌現後歸零（promote-then-consume）
  if (G[`${role}BonusEnergyNextTurn`]) {
    G[`${role}Energy`] = Math.min(20, G[`${role}Energy`] + G[`${role}BonusEnergyNextTurn`]);
    G[`${role}BonusEnergyNextTurn`] = 0;
  }
  if (G.activeStadium?.id === 'stadium-mega-prism' && !G[`${role}MegaUsed`]) {
    G[`${role}MegaEnergy`] = Math.min(20, (G[`${role}MegaEnergy`] || 0) + 16);
  }
  // 亡靈詛咒／暗影封鎖：封印Mega進化的回合倒數
  if (G[`${role}MegaSealedTurns`] > 0) G[`${role}MegaSealedTurns`]--;
  // 封印特性／詛咒：回合倒數，同一套pattern
  if (G[`${role}AbilitySealedTurns`] > 0) G[`${role}AbilitySealedTurns`]--;
  if (G[`${role}HealSealedTurns`] > 0) G[`${role}HealSealedTurns`]--;
  // 寄生種子：接下來N回合，每回合開始從對方身上吸取能量
  if (G[`${role}LeechTurns`] > 0) {
    const op = role === 'p1' ? 'p2' : 'p1';
    const amt = Math.min(3, G[`${op}Energy`] || 0);
    G[`${op}Energy`] = (G[`${op}Energy`] || 0) - amt;
    G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + amt);
    G[`${role}LeechTurns`]--;
  }
  // 妖精結界：異常狀態免疫的回合倒數
  if (G[`${role}StatusImmuneTurns`] > 0) G[`${role}StatusImmuneTurns`]--;
  const activePoke = G[`${role}Deck`][G[`${role}Idx`]];
  const itemsOnly = getDrawPool(activePoke.type, activePoke.type2);
  const n = 2;
  for (let i = 0; i < n; i++) {
    G[`${role}Hand`].push(weightedPick(itemsOnly));
  }
  // 冥想：上回合使用時承諾的額外道具/競技場抽牌
  if (G[`${role}BonusItemDrawsNextTurn`]) {
    for (let i = 0; i < G[`${role}BonusItemDrawsNextTurn`]; i++) {
      G[`${role}Hand`].push(weightedPick(itemsOnly));
    }
    G[`${role}BonusItemDrawsNextTurn`] = 0;
  }
  // 詭計：上回合使用時承諾的額外支援者抽牌（刻意破例——平常支援者卡只會在開局手牌出現）
  if (G[`${role}BonusSupporterDrawNextTurn`]) {
    const supporters = TRAINERS.filter(c => c.cat === 'supporter');
    G[`${role}Hand`].push(supporters[Math.floor(Math.random() * supporters.length)]);
    G[`${role}BonusSupporterDrawNextTurn`] = false;
  }
  G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;
}

// Draws 1-2 cards for each player (kept for backward compatibility).
function drawForBoth(G) {
  // Hot Springs: heal both active Pokémon 30 HP each turn
  if (G.activeStadium?.id === 'stadium-spring') {
    for (const role of ['p1', 'p2']) {
      const poke = G[`${role}Deck`][G[`${role}Idx`]];
      if (poke.cur > 0 && poke.cur < poke.hp) {
        poke.cur = Math.min(poke.hp, poke.cur + 30);
      }
    }
  }
  const itemsOnly = TRAINERS.filter(c => c.cat !== 'supporter');
  for (const role of ['p1', 'p2']) {
    const drawPool = itemsOnly;
    const n = 2;
    for (let i = 0; i < n; i++) {
      G[`${role}Hand`].push(drawPool[Math.floor(Math.random() * drawPool.length)]);
    }
    G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;
  }
}

/* ═══════════════════════════════════════════
   ROOM MANAGEMENT
═══════════════════════════════════════════ */
const rooms = new Map();

function genCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function freshBuff() { return { atkBonus:0, atkMult:1, shield:0, typeOverride:null, reflect:false, typeBoost:null }; }
// 封印特性（ability-seal）／詛咒（heal-seal，2026-07-22新增）：G沒有全域state（每個room各自一份），
// 所以跟其他判斷一樣要把G/role明確傳進來，不能像單人版那樣直接讀模組層級的G。
function isAbilitySealedSrv(role, G) { return (G[`${role}AbilitySealedTurns`] || 0) > 0; }
function isHealSealedSrv(role, G) { return (G[`${role}HealSealedTurns`] || 0) > 0; }

function buildG(room, startLog) {
  const firstTurn = Math.random() < 0.5 ? 'p1' : 'p2';
  room.coinFlip   = firstTurn;
  const G = {
    p1Deck: room.p1Team.map(clonePoke),
    p2Deck: room.p2Team.map(clonePoke),
    p1Idx: 0, p2Idx: 0,
    round:  1,
    turn:   firstTurn,
    pendingKOSwitch: null,
    p1Hand: dealHand(3), p2Hand: dealHand(3),
    p1Energy: 5, p2Energy: 5,
    p1MegaEnergy: 0, p2MegaEnergy: 0,
    p1MegaUsed: false, p2MegaUsed: false,
    p1SuppUsed: false, p1SuppStageUsed: 0,
    p2SuppUsed: false, p2SuppStageUsed: 0,
    p1HandCardUsed: false, p2HandCardUsed: false,
    p1FreeSwitch: false, p2FreeSwitch: false,
    p1SwitchedThisTurn: false, p2SwitchedThisTurn: false,
    p1SwitchGuard: false, p2SwitchGuard: false,
    p1Buff: freshBuff(), p2Buff: freshBuff(),
    p1NeedsDiscard: false, p2NeedsDiscard: false,
    p1Braced: false, p2Braced: false,
    p1CoinShield: false, p2CoinShield: false,
    p1BonusEnergyNextTurn: 0, p2BonusEnergyNextTurn: 0,
    p1BonusItemDrawsNextTurn: 0, p2BonusItemDrawsNextTurn: 0,
    p1BonusSupporterDrawNextTurn: false, p2BonusSupporterDrawNextTurn: false,
    activeStadium: null,
    winner: null,
  };
  triggerOnEnterSrv(G.p1Deck[0], 'p1', G, startLog);
  triggerOnEnterSrv(G.p2Deck[0], 'p2', G, startLog);
  return G;
}

/* ═══════════════════════════════════════════
   ACCOUNTS: password hashing + player pool
═══════════════════════════════════════════ */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/* 帳號收藏庫。2026-07-20後：註冊初始／損壞修復改成3隻（三區間各1隻，捕捉機制上線後隊伍改成
   從3隻起步、靠捕捉養到最多10隻），編輯隊伍候補仍然生成6隻（沿用舊行為，只是換卡候補數量跟
   起始隊伍大小脫鉤）。randomRoster(n) 保證三區間平均分配。 */
function generatePlayerPool(n = 6) {
  return randomRoster(n).map(p => p.id);
}

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg) {
  send(room.p1, msg); send(room.p2, msg);
  for (const s of (room.spectators || [])) send(s, msg);
}

/* 這個星期的星期一（UTC日期，YYYY-MM-DD）——每週排行榜靠這個分桶，不用排程/cron */
function mondayOfWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.toISOString().slice(0, 10);
}

/* 只在有登入的那一側才寫 weekly_stats；平手/雙方都匿名/DB不可用 → 完全no-op。
   非同步、不擋對戰結果broadcast——寫入失敗只記log，不影響這場對戰本身。 */
async function recordWeeklyStats(room, winner) {
  if (!pool || winner === 'draw') return;
  const winnerUserId = winner === 'p1' ? room.p1UserId : room.p2UserId;
  const loserRole    = winner === 'p1' ? 'p2' : 'p1';
  const loserUserId  = loserRole === 'p1' ? room.p1UserId : room.p2UserId;
  const weekStart = mondayOfWeek(new Date());
  const tasks = [];
  if (winnerUserId) {
    tasks.push(pool.query(
      `INSERT INTO weekly_stats (user_id, week_start_date, wins, losses) VALUES ($1, $2, 1, 0)
       ON CONFLICT (user_id, week_start_date) DO UPDATE SET wins = weekly_stats.wins + 1`,
      [winnerUserId, weekStart]
    ));
  }
  if (loserUserId) {
    tasks.push(pool.query(
      `INSERT INTO weekly_stats (user_id, week_start_date, wins, losses) VALUES ($1, $2, 0, 1)
       ON CONFLICT (user_id, week_start_date) DO UPDATE SET losses = weekly_stats.losses + 1`,
      [loserUserId, weekStart]
    ));
  }
  await Promise.all(tasks);
}

/* 集中處理全部11處game_over broadcast——統一設G.winner、broadcast、room.phase='done'，
   並只在對應側有userId時才記weekly_stats。DB寫入失敗不阻擋/不影響對戰結果broadcast本身。 */
function endGame(room, winner, log, extra = {}) {
  const G = room.G;
  G.winner = winner;
  broadcast(room, { type: 'game_over', winner, state: G, log, ...extra });
  room.phase = 'done';
  recordWeeklyStats(room, winner).catch(e => console.error('weekly_stats upsert error:', e.message));
}

/* 血量三區間：200-249／250-309／310+，PvP選隊要求玩家從三個區間各選1隻出戰 */
function hpBand(hp) {
  if (hp < 250) return 0;
  if (hp < 310) return 1;
  return 2;
}

/* 隨機抽取寶可夢陣容——三個血量區間各自獨立洗牌後平均分配（n=6時每區間保證剛好2隻），
   確保候補一定涵蓋三個區間，玩家才不會湊不出「三區間各選1隻」的合法出戰組合 */
function randomRoster(n = 6) {
  const bands = [[], [], []];
  for (const p of POKEMON) bands[hpBand(p.hp)].push(p);
  bands.forEach(b => b.sort(() => Math.random() - 0.5));
  const perBand = Math.floor(n / 3);
  const remainder = n - perBand * 3;
  const result = [];
  for (let b = 0; b < 3; b++) {
    const count = perBand + (b < remainder ? 1 : 0);
    result.push(...bands[b].slice(0, count));
  }
  return result.sort(() => Math.random() - 0.5);
}

/* ═══════════════════════════════════════════
   ACCOUNTS: REST routes
═══════════════════════════════════════════ */
async function requireAuth(req, res, next) {
  if (!pool) return res.status(503).json({ error: 'no_db' });
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { rows } = await pool.query(
      'SELECT id, username, is_admin FROM users WHERE session_token = $1 AND disabled = false',
      [token]
    );
    if (!rows.length) return res.status(401).json({ error: 'unauthorized' });
    req.user = rows[0];
    next();
  } catch (e) {
    console.error('requireAuth error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
}

/* 疊在 requireAuth 外面多一層——GM身分是直接在DB把 users.is_admin 標成true，沒有註冊流程 */
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).json({ error: 'forbidden' });
  next();
}

/* 讀取帳號收藏庫。隊伍大小2026-07-20後改成可變動（3隻起步，捕捉養到最多10隻），
   只有「完全空/所有id都在目前POKEMON名單裡找不到」才視為損壞重建成3隻——絕對不能把
   玩家捕捉養出來的4~10隻誤判成損壞而洗掉，所以拿掉了舊版「必須剛好是6」的檢查 */
async function loadUserTeam(userId) {
  const { rows } = await pool.query('SELECT pokemon_ids FROM teams WHERE user_id = $1', [userId]);
  let ids = rows[0]?.pokemon_ids || [];
  let mons = ids.map(id => POKEMON.find(p => p.id === id)).filter(Boolean);
  if (mons.length === 0) {
    ids = generatePlayerPool(3);
    mons = ids.map(id => POKEMON.find(p => p.id === id));
    await pool.query(
      `INSERT INTO teams (user_id, pokemon_ids) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET pokemon_ids = $2, updated_at = NOW()`,
      [userId, ids]
    );
  }
  return mons;
}

app.post('/api/register', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'no_db' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'invalid_password' });
  }
  try {
    const passwordHash = hashPassword(password);
    const token = crypto.randomBytes(32).toString('hex');
    const { rows } = await pool.query(
      'INSERT INTO users (username, password_hash, session_token) VALUES ($1, $2, $3) RETURNING id',
      [username, passwordHash, token]
    );
    const pokemonIds = generatePlayerPool(3);
    await pool.query('INSERT INTO teams (user_id, pokemon_ids) VALUES ($1, $2)', [rows[0].id, pokemonIds]);
    res.status(201).json({ token, username });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'username_taken' });
    console.error('register error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/login', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'no_db' });
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, password_hash FROM users WHERE username = $1 AND disabled = false',
      [username]
    );
    if (!rows.length || !verifyPassword(password, rows[0].password_hash)) {
      return res.status(401).json({ error: 'invalid_credentials' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE users SET session_token = $1 WHERE id = $2', [token, rows[0].id]);
    res.json({ token, username });
  } catch (e) {
    console.error('login error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/logout', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE users SET session_token = NULL WHERE id = $1', [req.user.id]);
    res.json({});
  } catch (e) {
    console.error('logout error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username });
});

app.get('/api/team', requireAuth, async (req, res) => {
  try {
    const team = await loadUserTeam(req.user.id);
    res.json({ team });
  } catch (e) {
    console.error('team error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 飢餓值lazy衰減——依實際經過時間（NOW() - last_fed_at）用SQL算出該掉幾點，套用後把錨點重置成NOW()。
   整段比較留在SQL裡，不把TIMESTAMPTZ讀回JS做日期運算（跟claim-daily-coins的CURRENT_DATE教訓同一個坑）。 */
async function decayHunger(userId) {
  const { rows } = await pool.query(
    `UPDATE pets
     SET hunger = GREATEST(0, hunger - FLOOR(EXTRACT(EPOCH FROM (NOW() - last_fed_at)) / $1)::int),
         last_fed_at = NOW()
     WHERE user_id = $2
     RETURNING hunger`,
    [HUNGER_DECAY_INTERVAL_SEC, userId]
  );
  return rows[0]?.hunger;
}

/* ═══ 我的寶可夢：選一次寵物之後只讀/更新好感度，不能重選（MVP範圍） ═══ */
app.get('/api/pet', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT species_id, happiness, coins, display_fish_id, ball_normal, ball_great, ball_ultra,
              fish_tank_pos_x, fish_tank_pos_y, fish_dex_pos_x, fish_dex_pos_y
       FROM pets WHERE user_id = $1`, [req.user.id]
    );
    const { rows: badgeRows } = await pool.query('SELECT badge_id, pos_x, pos_y FROM user_badges WHERE user_id = $1', [req.user.id]);
    const badges = badgeRows.filter(r => BADGES[r.badge_id]).map(r => ({ id: r.badge_id, ...BADGES[r.badge_id], x: r.pos_x, y: r.pos_y }));
    if (!rows.length) return res.json({ pet: null, badges });
    const { rows: decorRows } = await pool.query('SELECT item_id, pos_x, pos_y FROM pet_decorations WHERE user_id = $1', [req.user.id]);
    const decorations = decorRows.map(r => ({ itemId: r.item_id, x: r.pos_x, y: r.pos_y }));
    const hunger = await decayHunger(req.user.id);
    const { rows: fishRows } = await pool.query(
      'SELECT id, fish_type, caught_at, is_favorite FROM pet_fish WHERE user_id = $1 ORDER BY caught_at DESC', [req.user.id]
    );
    const fish = fishRows.map(r => ({ id: r.id, fishType: r.fish_type, caughtAt: r.caught_at, isFavorite: r.is_favorite, ...FISH_TYPES[r.fish_type] }));
    const displayFish = rows[0].display_fish_id ? (fish.find(f => f.id === rows[0].display_fish_id) || null) : null;
    const balls = { ballNormal: rows[0].ball_normal, ballGreat: rows[0].ball_great, ballUltra: rows[0].ball_ultra };
    const fishTankPos = rows[0].fish_tank_pos_x != null ? { x: rows[0].fish_tank_pos_x, y: rows[0].fish_tank_pos_y } : null;
    const fishDexPos = rows[0].fish_dex_pos_x != null ? { x: rows[0].fish_dex_pos_x, y: rows[0].fish_dex_pos_y } : null;
    res.json({
      pet: { speciesId: rows[0].species_id, happiness: rows[0].happiness, coins: rows[0].coins, hunger, ...balls, fishTankPos, fishDexPos },
      badges, decorations, fish, displayFish,
    });
  } catch (e) {
    console.error('pet fetch error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 每天依好感度核發一次金幣——沒有排程/cron，靠last_coin_grant_date欄位lazy判斷（跟weekly_stats
   的week_start_date分桶同一套手法），玩家進畫面時前端主動呼叫這個端點，不是背景排程推播。
   「今天有沒有領過」的比對整個交給Postgres的CURRENT_DATE做，不要把DATE欄位讀回JS再轉字串比較——
   node-postgres會把DATE用「本地時區午夜」解析成JS Date物件，之後.toISOString()轉回UTC字串時，
   在UTC+的時區（例如UTC+8）會整個位移成前一天，導致「今天領過」的判斷永遠比對不上、可以無限次
   領取金幣（用curl連續呼叫兩次實測抓到這個bug，兩次都回傳granted:true）。 */
app.post('/api/pet/claim-daily-coins', requireAuth, async (req, res) => {
  try {
    const { rows: hrows } = await pool.query('SELECT happiness FROM pets WHERE user_id = $1', [req.user.id]);
    if (!hrows.length) return res.status(404).json({ error: 'no_pet' });
    const gained = dailyCoinsForHappiness(hrows[0].happiness);
    const { rows, rowCount } = await pool.query(
      `UPDATE pets SET coins = coins + $1, last_coin_grant_date = CURRENT_DATE
       WHERE user_id = $2 AND (last_coin_grant_date IS NULL OR last_coin_grant_date < CURRENT_DATE)
       RETURNING coins`,
      [gained, req.user.id]
    );
    if (rowCount === 0) {
      const { rows: crows } = await pool.query('SELECT coins FROM pets WHERE user_id = $1', [req.user.id]);
      return res.json({ coins: crows[0].coins, granted: false });
    }
    res.json({ coins: rows[0].coins, granted: true, gained });
  } catch (e) {
    console.error('pet claim-daily-coins error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 不需要登入就能看——純顯示用途，跟BADGES一樣是純資料registry */
app.get('/api/shop', (req, res) => {
  res.json({ items: SHOP_ITEMS });
});

/* 寶可夢圖鑑——給「我的寶可夢」頁面的圖鑑彈窗用，裁剪成顯示會用到的欄位（不含attacks的完整
   數值細節，那是戰鬥引擎的事）。不需要登入，比照/api/shop的公開唯讀慣例。 */
app.get('/api/pokedex', (req, res) => {
  const dex = POKEMON.map(p => ({
    id: p.id, name: p.name, type: p.type, type2: p.type2 ?? null,
    hp: p.hp, tier: p.tier, ability: p.ability ?? null, mega: p.mega ?? null,
  }));
  res.json({ dex });
});

app.post('/api/pet/buy', requireAuth, async (req, res) => {
  const itemId = req.body?.itemId;
  const item = SHOP_ITEMS[itemId];
  if (!item) return res.status(400).json({ error: 'invalid_item' });
  try {
    const { rows } = await pool.query('SELECT 1 FROM pets WHERE user_id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'no_pet' });
    // 球是消耗品，允許重複購買囤貨——跟裝飾品的一次性擁有邏輯是不同分支。
    // 2026-07-22：改成單一原子UPDATE（金幣夠不夠也放進WHERE子句一起判斷），拿掉原本「先SELECT
    // 讀數量、JS算完新值再UPDATE」的兩段式讀寫——原寫法在併發請求（雙擊購買、開兩分頁）下，
    // 兩個請求可能都讀到同一個舊值，其中一次的購買效果會被覆蓋消失，這是使用者回報「捕捉時
    // 發現球其實沒買到」的根因之一（買球端點也有一樣的race condition，不是只有丟球端點）。
    if (item.category === 'ball') {
      const { rows: updated } = await pool.query(
        `UPDATE pets SET coins = coins - $1, ${item.ballField} = ${item.ballField} + 1
         WHERE user_id = $2 AND coins >= $1
         RETURNING coins, ${item.ballField} AS count`,
        [item.price, req.user.id]
      );
      if (!updated.length) return res.status(400).json({ error: 'not_enough_coins' });
      return res.status(201).json({ coins: updated[0].coins, ballField: item.ballField, count: updated[0].count });
    }
    const { rows: coinRows } = await pool.query('SELECT coins FROM pets WHERE user_id = $1', [req.user.id]);
    if (coinRows[0].coins < item.price) return res.status(400).json({ error: 'not_enough_coins' });
    const { rows: ownedRows } = await pool.query(
      'SELECT 1 FROM pet_decorations WHERE user_id = $1 AND item_id = $2', [req.user.id, itemId]
    );
    if (ownedRows.length) return res.status(409).json({ error: 'already_owned' });
    const coins = coinRows[0].coins - item.price;
    await pool.query('UPDATE pets SET coins = $1 WHERE user_id = $2', [coins, req.user.id]);
    await pool.query('INSERT INTO pet_decorations (user_id, item_id) VALUES ($1, $2)', [req.user.id, itemId]);
    res.status(201).json({ coins });
  } catch (e) {
    console.error('pet buy error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 捕捉第1步：花100金幣讓一隻野生寶可夢出現。不消耗球、不判定捕捉成功與否——
   跟釣魚一樣，真正的隨機結果（丟球成功率）要留到 catch/throw 才由伺服器端擲，不能讓client先看到結果。
   2026-07-22：每次遭遇都無條件多送5顆一般球（使用者要求的持續性機制），跟扣100金幣同一個原子UPDATE
   一起做，回應夾帶最新的coins/ballNormal讓前端不用另外呼叫別的端點就能同步顯示。 */
app.post('/api/pet/catch/encounter', requireAuth, async (req, res) => {
  const ENCOUNTER_COST = 100;
  const FREE_BALLS_PER_ENCOUNTER = 5;
  const existing = activeEncounters.get(req.user.id);
  if (existing && existing.expiresAt > Date.now()) {
    return res.status(400).json({ error: 'encounter_in_progress' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE pets SET coins = coins - $1, ball_normal = ball_normal + $2
       WHERE user_id = $3 AND coins >= $1
       RETURNING coins, ball_normal`,
      [ENCOUNTER_COST, FREE_BALLS_PER_ENCOUNTER, req.user.id]
    );
    if (!rows.length) {
      const { rows: existsRows } = await pool.query('SELECT 1 FROM pets WHERE user_id = $1', [req.user.id]);
      return res.status(existsRows.length ? 400 : 404).json({ error: existsRows.length ? 'not_enough_coins' : 'no_pet' });
    }
    const wild = POKEMON[Math.floor(Math.random() * POKEMON.length)];
    activeEncounters.set(req.user.id, { pokemonId: wild.id, name: wild.name, tier: wild.tier, expiresAt: Date.now() + ENCOUNTER_TTL_MS });
    res.json({ coins: rows[0].coins, ballNormal: rows[0].ball_normal, pokemonId: wild.id, name: wild.name, tier: wild.tier });
  } catch (e) {
    console.error('pet catch encounter error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 捕捉第2步：丟球。伺服器端原子完成「驗證持有球數→扣球→擲成功率→依隊伍狀態決定加入/發金幣/待放生」，
   不信任client回報「我抓到了」——跟釣魚 rollFish() 同一套教訓。
   2026-07-21：沒抓到不代表遭遇結束——只要玩家還有球就能對同一隻野生寶可夢繼續丟，
   除非骰到1%的「激烈反抗」讓寶可夢直接逃跑（activeEncounters 才會被清掉）。
   2026-07-22：整段包成一個交易（pool.connect()取專屬client，BEGIN/COMMIT/ROLLBACK）——扣球、
   擲成功率、依隊伍狀態決定加入/發金幣/待放生，要嘛全部一起生效、要嘛完全沒發生。原本沒有交易
   保護時，扣球是獨立的一次UPDATE，若後面任何一步意外拋錯，球已經真的被扣掉、activeEncounters
   也已經清空且無法恢復，玩家只會看到一個含糊的503——這是使用者回報「捕捉連線有時候出問題」的
   根因之一。回應一律夾帶扣完球之後的最新三種球數量，前端不用另外猜。 */
app.post('/api/pet/catch/throw', requireAuth, async (req, res) => {
  const pokemonId = Number(req.body?.pokemonId);
  const ballType = req.body?.ballType;
  const ballItem = SHOP_ITEMS[ballType];
  const wild = POKEMON.find(p => p.id === pokemonId);
  if (!wild || !ballItem || ballItem.category !== 'ball') return res.status(400).json({ error: 'invalid_request' });

  // 同步「認領」這次遭遇——檢查通過後立刻在這裡（任何await之前）就把它從Map刪掉，而不是等
  // 交易結束才刪。壓力測試時發現：如果檢查跟刪除中間隔著DB的await，兩個併發的丟球請求可能都
  // 通過檢查、各自獨立擲一次成功率，導致同一隻遭遇被「抓到」兩次。同步刪除後，只有第一個
  // 拿到encounter的請求會繼續往下走，其餘併發請求會直接落到no_active_encounter。
  // 只要這次丟球沒有真的讓遭遇結束（沒球/擲失敗沒逃跑/發生例外），下面對應分支都要記得
  // 把encounter放回去，不然遭遇會憑空消失。
  const encounter = activeEncounters.get(req.user.id);
  if (!encounter || encounter.pokemonId !== pokemonId || encounter.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'no_active_encounter' });
  }
  activeEncounters.delete(req.user.id);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE pets SET ${ballItem.ballField} = ${ballItem.ballField} - 1
       WHERE user_id = $1 AND ${ballItem.ballField} >= 1
       RETURNING ball_normal, ball_great, ball_ultra`,
      [req.user.id]
    );
    if (!rows.length) {
      await client.query('ROLLBACK');
      activeEncounters.set(req.user.id, encounter); // 沒球，這次丟球沒發生，遭遇原樣放回去
      return res.status(400).json({ error: 'no_balls' });
    }
    const ballCounts = { ballNormal: rows[0].ball_normal, ballGreat: rows[0].ball_great, ballUltra: rows[0].ball_ultra };

    const rate = BALL_CATCH_RATE[ballType] * (CATCH_TIER_MULT[wild.tier] ?? 1);
    const success = Math.random() < rate;

    if (!success) {
      const fierce = Math.random() < FIERCE_RESISTANCE_CHANCE;
      await client.query('COMMIT');
      // 沒抓到又沒激烈反抗——遭遇還沒結束，放回去讓玩家可以繼續丟；順便延長一點過期時間，
      // 避免玩家丟了好幾次球之後卡在快過期的邊緣
      if (!fierce) activeEncounters.set(req.user.id, { ...encounter, expiresAt: Date.now() + ENCOUNTER_TTL_MS });
      return res.json({ caught: false, fled: fierce, ...ballCounts });
    }

    const { rows: teamRows } = await client.query('SELECT pokemon_ids FROM teams WHERE user_id = $1', [req.user.id]);
    const currentIds = teamRows[0]?.pokemon_ids || [];
    let responsePayload, pendingRelease = null;
    if (currentIds.includes(pokemonId)) {
      const { rows: coinRows } = await client.query(
        'UPDATE pets SET coins = coins + 300 WHERE user_id = $1 RETURNING coins', [req.user.id]
      );
      responsePayload = { caught: true, duplicate: true, coinsAwarded: 300, coins: coinRows[0].coins, pokemonId, name: wild.name, ...ballCounts };
    } else if (currentIds.length < 10) {
      const newIds = [...currentIds, pokemonId];
      await client.query(
        `INSERT INTO teams (user_id, pokemon_ids) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET pokemon_ids = $2, updated_at = NOW()`,
        [req.user.id, newIds]
      );
      responsePayload = { caught: true, added: true, pokemonId, name: wild.name, ...ballCounts };
    } else {
      // 隊伍已滿10隻，且不是重複——先記在記憶體，等玩家選好要放生誰才真的寫進DB
      pendingRelease = { pokemonId, expiresAt: Date.now() + PENDING_RELEASE_TTL_MS };
      responsePayload = { caught: true, needsRelease: true, pokemonId, name: wild.name, ...ballCounts };
    }
    await client.query('COMMIT'); // 抓到了，這次遭遇真的結束，encounter不放回去
    if (pendingRelease) pendingCatchReleases.set(req.user.id, pendingRelease);
    res.json(responsePayload);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 連線本身可能已經斷了，rollback失敗就不用管 */ }
    activeEncounters.set(req.user.id, encounter); // 例外導致整個交易沒生效，遭遇原樣放回去讓玩家能重試
    console.error('pet catch throw error:', e.message);
    res.status(503).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

/* 玩家主動放棄這次遭遇（不繼續丟球）——退回90金幣（encounter花的100扣掉10點「探索費」不退）。
   只有真的有進行中的遭遇才能退款，防止重複呼叫這個端點刷金幣。 */
app.post('/api/pet/catch/giveup', requireAuth, async (req, res) => {
  const encounter = activeEncounters.get(req.user.id);
  if (!encounter || encounter.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'no_active_encounter' });
  }
  try {
    activeEncounters.delete(req.user.id);
    const { rows } = await pool.query('SELECT coins FROM pets WHERE user_id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'no_pet' });
    const coins = rows[0].coins + CATCH_GIVEUP_REFUND;
    await pool.query('UPDATE pets SET coins = $1 WHERE user_id = $2', [coins, req.user.id]);
    res.json({ coins, refunded: CATCH_GIVEUP_REFUND });
  } catch (e) {
    console.error('pet catch giveup error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 捕捉第3步（只有隊伍剛好滿10隻時才會用到）：從剛才 catch/throw 記下的待放生狀態裡，
   驗證 newPokemonId 真的對得上，玩家選1隻放生（releasePokemonId 可以等於 newPokemonId 本身＝放棄這次捕捉）*/
app.post('/api/pet/catch/resolve-release', requireAuth, async (req, res) => {
  const newPokemonId = Number(req.body?.newPokemonId);
  const releasePokemonId = Number(req.body?.releasePokemonId);
  const pending = pendingCatchReleases.get(req.user.id);
  if (!pending || pending.pokemonId !== newPokemonId || pending.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'no_pending_release' });
  }
  try {
    if (releasePokemonId === newPokemonId) {
      pendingCatchReleases.delete(req.user.id);
      return res.json({ released: false, kept: 'existing' }); // 玩家選擇放棄這次捕捉，隊伍不變
    }
    const { rows: teamRows } = await pool.query('SELECT pokemon_ids FROM teams WHERE user_id = $1', [req.user.id]);
    const currentIds = teamRows[0]?.pokemon_ids || [];
    if (!currentIds.includes(releasePokemonId)) return res.status(400).json({ error: 'invalid_release_target' });
    const newIds = currentIds.filter(id => id !== releasePokemonId).concat(newPokemonId);
    const newMons = newIds.map(id => POKEMON.find(p => p.id === id)).filter(Boolean);
    // 安全檢查：放生後三個血量區間都要還有至少1隻，不然玩家會卡在PvP選隊畫面湊不出合法隊伍
    // 這裡刻意還沒刪pendingCatchReleases——擋下的話玩家要能換一隻放生對象重試，不用重新花錢捕捉
    if (new Set(newMons.map(p => hpBand(p.hp))).size !== 3) {
      return res.status(400).json({ error: 'would_break_hp_bands' });
    }
    await pool.query(
      `INSERT INTO teams (user_id, pokemon_ids) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET pokemon_ids = $2, updated_at = NOW()`,
      [req.user.id, newIds]
    );
    pendingCatchReleases.delete(req.user.id);
    res.json({ released: true, releasedPokemonId: releasePokemonId, addedPokemonId: newPokemonId });
  } catch (e) {
    console.error('pet catch resolve-release error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* x/y為null代表收回道具欄；房間裝飾改成自由拖曳座標後不再有固定插槽，
   改用「同時擺放幾件」的數量上限（DECOR_PLACE_LIMIT）防止房間被塞爆——
   使用者明確要求維持上限、不要取消（見規劃討論）。座標是相對#pet-stage寬高的0~1標準化分數，
   跟setupVisitSprite()既有的placeAt(fracX,fracY)手法同一套模型。 */
app.post('/api/pet/place', requireAuth, async (req, res) => {
  const { itemId } = req.body || {};
  let { x, y } = req.body || {};
  x = (x === null || x === undefined) ? null : Number(x);
  y = (y === null || y === undefined) ? null : Number(y);
  if (x !== null && (Number.isNaN(x) || x < 0 || x > 1)) return res.status(400).json({ error: 'invalid_position' });
  if (y !== null && (Number.isNaN(y) || y < 0 || y > 1)) return res.status(400).json({ error: 'invalid_position' });
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM pet_decorations WHERE user_id = $1 AND item_id = $2', [req.user.id, itemId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    if (x !== null) {
      const { rows: countRows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM pet_decorations WHERE user_id = $1 AND pos_x IS NOT NULL AND item_id != $2',
        [req.user.id, itemId]
      );
      if (countRows[0].n >= DECOR_PLACE_LIMIT) return res.status(400).json({ error: 'limit_reached' });
    }
    await pool.query('UPDATE pet_decorations SET pos_x = $1, pos_y = $2 WHERE user_id = $3 AND item_id = $4', [x, y, req.user.id, itemId]);
    res.json({});
  } catch (e) {
    console.error('pet place error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 玩家自己把擁有的徽章放進房間／收回，跟上面/api/pet/place裝飾的語意完全一致
   （x/y為null=收回、上限用BADGE_PLACE_LIMIT），只是操作的是user_badges表而不是pet_decorations。 */
app.post('/api/pet/badge/position', requireAuth, async (req, res) => {
  const { badgeId } = req.body || {};
  let { x, y } = req.body || {};
  x = (x === null || x === undefined) ? null : Number(x);
  y = (y === null || y === undefined) ? null : Number(y);
  if (x !== null && (Number.isNaN(x) || x < 0 || x > 1)) return res.status(400).json({ error: 'invalid_position' });
  if (y !== null && (Number.isNaN(y) || y < 0 || y > 1)) return res.status(400).json({ error: 'invalid_position' });
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM user_badges WHERE user_id = $1 AND badge_id = $2', [req.user.id, badgeId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    if (x !== null) {
      const { rows: countRows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM user_badges WHERE user_id = $1 AND pos_x IS NOT NULL AND badge_id != $2',
        [req.user.id, badgeId]
      );
      if (countRows[0].n >= BADGE_PLACE_LIMIT) return res.status(400).json({ error: 'limit_reached' });
    }
    await pool.query('UPDATE user_badges SET pos_x = $1, pos_y = $2 WHERE user_id = $3 AND badge_id = $4', [x, y, req.user.id, badgeId]);
    res.json({});
  } catch (e) {
    console.error('pet badge position error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 魚缸／魚圖鑑聲納這兩個固定裝置的位置——沒有「收回」概念（一直都在房間裡），
   也沒有數量上限（固定只有這兩個），單純記錄玩家拖曳後的最新座標。 */
const FIXTURE_POS_FIELDS = {
  fish_tank: ['fish_tank_pos_x', 'fish_tank_pos_y'],
  fish_dex: ['fish_dex_pos_x', 'fish_dex_pos_y'],
};
app.post('/api/pet/fixture/position', requireAuth, async (req, res) => {
  const { fixture } = req.body || {};
  const fields = FIXTURE_POS_FIELDS[fixture];
  if (!fields) return res.status(400).json({ error: 'invalid_fixture' });
  const x = Number(req.body?.x), y = Number(req.body?.y);
  if (Number.isNaN(x) || x < 0 || x > 1 || Number.isNaN(y) || y < 0 || y > 1) return res.status(400).json({ error: 'invalid_position' });
  try {
    await pool.query(`UPDATE pets SET ${fields[0]} = $1, ${fields[1]} = $2 WHERE user_id = $3`, [x, y, req.user.id]);
    res.json({});
  } catch (e) {
    console.error('pet fixture position error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pet/choose', requireAuth, async (req, res) => {
  const speciesId = Number(req.body?.speciesId);
  if (!PET_SPECIES.some(s => s.id === speciesId)) {
    return res.status(400).json({ error: 'invalid_species' });
  }
  try {
    const { rows } = await pool.query('SELECT species_id FROM pets WHERE user_id = $1', [req.user.id]);
    if (rows.length) return res.status(409).json({ error: 'already_chosen' });
    // 起始金幣 1000（2026-07-20）——捕捉機制需要玩家一開始就有能力嘗試幾次
    await pool.query('INSERT INTO pets (user_id, species_id, coins) VALUES ($1, $2, 1000)', [req.user.id, speciesId]);
    res.status(201).json({ pet: { speciesId, happiness: 50, coins: 1000 } });
  } catch (e) {
    console.error('pet choose error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

const PET_REACTIONS = ['開心地叫了一聲！', '搖了搖尾巴！', '眼睛閃閃發亮！', '蹭了蹭你！', '開心地跳了起來！'];
const PET_INTERACT_COOLDOWN_MS = 3000; // 防止洗好感度，冷卻期間重複點擊不加分
app.post('/api/pet/interact', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT species_id, happiness, last_interaction_at FROM pets WHERE user_id = $1', [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'no_pet' });
    const pet = rows[0];
    const lastAt = pet.last_interaction_at ? new Date(pet.last_interaction_at).getTime() : 0;
    if (Date.now() - lastAt < PET_INTERACT_COOLDOWN_MS) {
      return res.json({ happiness: pet.happiness, reaction: null, cooldown: true });
    }
    const happiness = Math.min(100, pet.happiness + 1);
    await pool.query('UPDATE pets SET happiness = $1, last_interaction_at = NOW() WHERE user_id = $2', [happiness, req.user.id]);
    const reaction = PET_REACTIONS[Math.floor(Math.random() * PET_REACTIONS.length)];
    res.json({ happiness, reaction, cooldown: false });
  } catch (e) {
    console.error('pet interact error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 餵食：先lazy衰減、再判斷吃不吃得下。「吃飽了不能再餵」本身就是節流，不用另外做冷卻計時器。 */
const PET_FEED_REACTIONS = ['大口大口地吃了起來！', '滿足地咂咂嘴！', '吃得津津有味！', '開心地吃光光！'];
app.post('/api/pet/feed', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT happiness FROM pets WHERE user_id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'no_pet' });
    const hunger = await decayHunger(req.user.id);
    if (hunger >= 100) return res.json({ fed: false, reason: 'full', hunger });
    const newHunger = Math.min(100, hunger + 25);
    const newHappiness = Math.min(100, rows[0].happiness + 2);
    await pool.query('UPDATE pets SET hunger = $1, happiness = $2 WHERE user_id = $3', [newHunger, newHappiness, req.user.id]);
    const reaction = PET_FEED_REACTIONS[Math.floor(Math.random() * PET_FEED_REACTIONS.length)];
    res.json({ fed: true, hunger: newHunger, happiness: newHappiness, reaction });
  } catch (e) {
    console.error('pet feed error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 釣魚：完全免費、不限次數（使用者確認過不用金幣成本也不用每日次數上限）。抽獎+存檔在同一次
   呼叫裡原子完成——不要拆成「先跟前端要抽獎結果、前端點『收進魚籃』才存檔」兩段式，那樣等於
   讓client端事後回報一個信任的結果，前端隨便送個fishType='red-gyarados'就能無中生有一條魚。
   前端UI上的「跳結果→點擊收進魚籃」兩步驟感覺，靠這次回應裡已經帶的完整魚資料，在前端本地
   模擬那個節奏就好，不需要真的補第二次網路請求。 */
app.post('/api/pet/fish', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 FROM pets WHERE user_id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'no_pet' });
    const fishType = rollFish();
    if (fishType === 'none') {
      return res.json({ fishType, ...FISH_TYPES[fishType] });
    }
    const { rows: insertRows } = await pool.query(
      'INSERT INTO pet_fish (user_id, fish_type) VALUES ($1, $2) RETURNING id, caught_at',
      [req.user.id, fishType]
    );
    // 魚圖鑑用的永久「曾經釣到過」紀錄，跟pet_fish本身分開（賣掉不會清掉這筆）
    await pool.query(
      'INSERT INTO pet_fish_discovered (user_id, fish_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, fishType]
    );
    res.json({ fishType, ...FISH_TYPES[fishType], fishId: insertRows[0].id, caughtAt: insertRows[0].caught_at });
  } catch (e) {
    console.error('pet fish error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 魚圖鑑——列出FISH_TYPES裡每一種可釣到的魚（排除none），標示這個帳號是否曾經釣到過。
   discovered是查pet_fish_discovered這張獨立的永久紀錄表，不是看目前pet_fish裡還擁不擁有——
   賣掉某種魚的最後一隻，圖鑑不會因此退回「未發現」。 */
app.get('/api/pet/fish/dex', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT fish_type FROM pet_fish_discovered WHERE user_id = $1', [req.user.id]);
    const discoveredSet = new Set(rows.map(r => r.fish_type));
    const dex = Object.entries(FISH_TYPES)
      .filter(([fishType]) => fishType !== 'none')
      .map(([fishType, info]) => ({ fishType, ...info, discovered: discoveredSet.has(fishType) }));
    res.json({ dex });
  } catch (e) {
    console.error('pet fish dex error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pet/fish/display', requireAuth, async (req, res) => {
  const fishId = req.body?.fishId ?? null;
  try {
    if (fishId !== null) {
      const { rows } = await pool.query('SELECT 1 FROM pet_fish WHERE id = $1 AND user_id = $2', [fishId, req.user.id]);
      if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    }
    await pool.query('UPDATE pets SET display_fish_id = $1 WHERE user_id = $2', [fishId, req.user.id]);
    res.json({});
  } catch (e) {
    console.error('pet fish display error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 賣魚換金幣——直接DELETE那筆pet_fish就好，如果賣掉的剛好是目前展示中的那隻，
   pets.display_fish_id的外鍵是ON DELETE SET NULL，Postgres會自動清空展示欄位，
   不用另外手動UPDATE。標記「我的最愛」的魚一律拒賣，防止誤賣（2026-07-22新增）。 */
app.post('/api/pet/fish/sell', requireAuth, async (req, res) => {
  const fishId = req.body?.fishId;
  try {
    const { rows } = await pool.query('SELECT fish_type, is_favorite FROM pet_fish WHERE id = $1 AND user_id = $2', [fishId, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    if (rows[0].is_favorite) return res.status(400).json({ error: 'is_favorite' });
    const price = FISH_TYPES[rows[0].fish_type]?.sellPrice || 0;
    await pool.query('DELETE FROM pet_fish WHERE id = $1', [fishId]);
    const { rows: updated } = await pool.query(
      'UPDATE pets SET coins = coins + $1 WHERE user_id = $2 RETURNING coins', [price, req.user.id]
    );
    res.json({ coins: updated[0].coins, gained: price });
  } catch (e) {
    console.error('pet fish sell error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 切換單筆魚的「我的最愛」標記——標記後sell()會拒絕賣出，避免誤賣稀有魚（例如金色/傳說魚種）。 */
app.post('/api/pet/fish/favorite', requireAuth, async (req, res) => {
  const fishId = req.body?.fishId;
  const favorite = !!req.body?.favorite;
  try {
    const { rows } = await pool.query(
      'UPDATE pet_fish SET is_favorite = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
      [favorite, fishId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    res.json({ fishId, favorite });
  } catch (e) {
    console.error('pet fish favorite error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 一鍵賣掉重複的魚——每個魚種最多留1隻（優先留最新釣到的），標記「我的最愛」的魚完全不列入
   刪除候選（永遠保留，不計入「留1隻」的名額）。用ROW_NUMBER()一次算完要刪哪些列，
   RETURNING拿到被刪魚種清單換算總金幣，比一筆一筆呼叫/api/pet/fish/sell乾淨很多。 */
app.post('/api/pet/fish/sell-duplicates', requireAuth, async (req, res) => {
  try {
    const { rows: deleted } = await pool.query(
      `WITH ranked AS (
         SELECT id, fish_type,
           ROW_NUMBER() OVER (PARTITION BY fish_type ORDER BY caught_at DESC) AS rn
         FROM pet_fish
         WHERE user_id = $1 AND is_favorite = FALSE
       )
       DELETE FROM pet_fish WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
       RETURNING id, fish_type`,
      [req.user.id]
    );
    const gained = deleted.reduce((sum, row) => sum + (FISH_TYPES[row.fish_type]?.sellPrice || 0), 0);
    const { rows: updated } = await pool.query(
      'UPDATE pets SET coins = coins + $1 WHERE user_id = $2 RETURNING coins', [gained, req.user.id]
    );
    res.json({ coins: updated[0].coins, gained, soldIds: deleted.map(r => r.id), soldCount: deleted.length });
  } catch (e) {
    console.error('pet fish sell-duplicates error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 拜訪朋友：唯讀查詢，不需要好友關係（沒有好友清單系統，比照排行榜的開放程度）。
   刻意不回傳coins——別人的錢包餘額沒有展示必要。 */
app.get('/api/pet/visit/:username', requireAuth, async (req, res) => {
  try {
    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE username = $1', [req.params.username]);
    if (!userRows.length) return res.status(404).json({ error: 'user_not_found' });
    const targetId = userRows[0].id;
    const { rows: petRows } = await pool.query('SELECT species_id, happiness FROM pets WHERE user_id = $1', [targetId]);
    if (!petRows.length) return res.status(404).json({ error: 'no_pet' });
    const { rows: decorRows } = await pool.query(
      'SELECT item_id, pos_x, pos_y FROM pet_decorations WHERE user_id = $1 AND pos_x IS NOT NULL', [targetId]
    );
    const decorations = decorRows.map(r => ({ itemId: r.item_id, x: r.pos_x, y: r.pos_y }));
    const { rows: badgeRows } = await pool.query(
      'SELECT badge_id, pos_x, pos_y FROM user_badges WHERE user_id = $1 AND pos_x IS NOT NULL', [targetId]
    );
    const badges = badgeRows.filter(r => BADGES[r.badge_id]).map(r => ({ id: r.badge_id, ...BADGES[r.badge_id], x: r.pos_x, y: r.pos_y }));
    res.json({
      username: req.params.username,
      pet: { speciesId: petRows[0].species_id, happiness: petRows[0].happiness },
      badges,
      decorations,
    });
  } catch (e) {
    console.error('pet visit error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 不需要登入就能看——純顯示用途；週次靠日期分桶，沒有排程/cron，"重置"是隱含的（新的一週第一場結束就自然開新的一列） */
app.get('/api/leaderboard', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'no_db' });
  try {
    const weekStart = mondayOfWeek(new Date());
    const { rows } = await pool.query(
      `SELECT u.username, ws.wins, ws.losses,
              CASE WHEN ws.wins + ws.losses = 0 THEN 0
                   ELSE ws.wins::float / (ws.wins + ws.losses) END AS win_rate
       FROM weekly_stats ws
       JOIN users u ON u.id = ws.user_id
       WHERE ws.week_start_date = $1
       ORDER BY ws.wins DESC, win_rate DESC LIMIT 50`,
      [weekStart]
    );
    res.json({ weekStart, entries: rows });
  } catch (e) {
    console.error('leaderboard error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* ── GM 管理後台：都掛 requireAuth + requireAdmin 兩層 ── */
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const weekStart = mondayOfWeek(new Date());
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.created_at, u.disabled, u.is_admin,
              COALESCE(ws.wins, 0) AS this_week_wins,
              COALESCE(ARRAY_AGG(ub.badge_id) FILTER (WHERE ub.badge_id IS NOT NULL), '{}') AS badge_ids
       FROM users u
       LEFT JOIN weekly_stats ws ON ws.user_id = u.id AND ws.week_start_date = $1
       LEFT JOIN user_badges ub ON ub.user_id = u.id
       GROUP BY u.id, ws.wins
       ORDER BY u.id`,
      [weekStart]
    );
    res.json({ users: rows.map(r => ({
      id: r.id, username: r.username, createdAt: r.created_at,
      disabled: r.disabled, isAdmin: r.is_admin, thisWeekWins: r.this_week_wins,
      badgeIds: r.badge_ids,
    })), badges: BADGES });
  } catch (e) {
    console.error('admin users error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 只是切換停用狀態，不刪資料——team/weekly_stats都保留，跟DELETE是唯一真的刪資料的端點分開 */
app.post('/api/admin/users/:id/disable', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    await pool.query('UPDATE users SET disabled = $1 WHERE id = $2', [!!req.body?.disabled, id]);
    res.json({});
  } catch (e) {
    console.error('admin disable error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 手動頒發/收回玩家的徽章——目前沒有「每週自動判定冠軍」的排程機制，GM每週手動幫排行榜第一名點一下。
   玩家可以同時擁有多個徽章（user_badges是多對多），award/revoke分成兩支端點，
   不像舊版單一badge_id欄位那樣「指定新的就整個覆蓋掉舊的」。新頒發的徽章pos預設NULL，
   放進玩家的徽章收藏、由玩家自己決定要不要擺進房間展示。 */
app.post('/api/admin/users/:id/badges/award', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const badgeId = req.body?.badgeId;
  if (!badgeId || !BADGES[badgeId]) return res.status(400).json({ error: 'invalid_badge' });
  try {
    await pool.query('INSERT INTO user_badges (user_id, badge_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, badgeId]);
    res.json({});
  } catch (e) {
    console.error('admin badge award error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/admin/users/:id/badges/revoke', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const badgeId = req.body?.badgeId;
  if (!badgeId) return res.status(400).json({ error: 'invalid_badge' });
  try {
    await pool.query('DELETE FROM user_badges WHERE user_id = $1 AND badge_id = $2', [id, badgeId]);
    res.json({});
  } catch (e) {
    console.error('admin badge revoke error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 硬刪除，靠 teams/weekly_stats 的 ON DELETE CASCADE 一起清掉——這是唯一真的會讓資料消失的操作 */
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.json({});
  } catch (e) {
    console.error('admin delete error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 沒有email，這是玩家忘記密碼時唯一的救濟手段——順便清掉舊session，逼玩家用新密碼重新登入 */
app.post('/api/admin/users/:id/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { newPassword } = req.body || {};
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: 'invalid_password' });
  try {
    await pool.query('UPDATE users SET password_hash = $1, session_token = NULL WHERE id = $2', [hashPassword(newPassword), id]);
    res.json({});
  } catch (e) {
    console.error('admin reset-password error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 直接覆寫（不是累加）某玩家某週的勝敗數字，用於修正bug或作弊——沒有自動填today的week，GM要自己選週次 */
app.post('/api/admin/stats/:userId', requireAuth, requireAdmin, async (req, res) => {
  const userId = Number(req.params.userId);
  const { weekStartDate, wins, losses } = req.body || {};
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'invalid_id' });
  if (typeof weekStartDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStartDate)) return res.status(400).json({ error: 'invalid_week' });
  if (!Number.isInteger(wins) || wins < 0 || !Number.isInteger(losses) || losses < 0) return res.status(400).json({ error: 'invalid_stats' });
  try {
    await pool.query(
      `INSERT INTO weekly_stats (user_id, week_start_date, wins, losses) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, week_start_date) DO UPDATE SET wins = $3, losses = $4`,
      [userId, weekStartDate, wins, losses]
    );
    res.json({});
  } catch (e) {
    console.error('admin stats error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 手動幫玩家補回一筆魚——目前唯一的用途是誤賣後的人工還原（沒有UNDO功能，這是GM唯一的救濟手段）。
   用帳號名稱查而不是內部id，GM操作時比較直覺（不用先去使用者列表對照id）。也順手補一筆discovered
   紀錄，這樣萬一是「唯一一隻也賣掉導致圖鑑退回未發現」的情境，還原後圖鑑會一起正確顯示。 */
app.post('/api/admin/fish/restore', requireAuth, requireAdmin, async (req, res) => {
  const { username, fishType } = req.body || {};
  if (typeof username !== 'string' || !username) return res.status(400).json({ error: 'invalid_username' });
  if (typeof fishType !== 'string' || fishType === 'none' || !FISH_TYPES[fishType]) return res.status(400).json({ error: 'invalid_fish_type' });
  try {
    const { rows: userRows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (!userRows.length) return res.status(404).json({ error: 'user_not_found' });
    const userId = userRows[0].id;
    const { rows } = await pool.query(
      'INSERT INTO pet_fish (user_id, fish_type) VALUES ($1, $2) RETURNING id, caught_at',
      [userId, fishType]
    );
    await pool.query(
      'INSERT INTO pet_fish_discovered (user_id, fish_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, fishType]
    );
    res.status(201).json({ fishId: rows[0].id, fishType, caughtAt: rows[0].caught_at, ...FISH_TYPES[fishType] });
  } catch (e) {
    console.error('admin fish restore error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* ═══════════════════════════════════════════
   WEBSOCKET
═══════════════════════════════════════════ */
wss.on('connection', (ws, req) => {
  ws.roomCode = null;
  ws.role     = null;
  ws.userId   = null;
  ws.username = null;

  /* 帶token就驗證，驗證失敗/沒帶token/沒有pool一律當匿名放行，絕不拒絕連線。
     驗證是非同步的，所以先把connection期間收到的訊息排隊，驗證完（不管成功失敗）再依序處理，
     避免玩家連線後馬上動作時，因為token還沒驗完而漏接第一則訊息。 */
  const msgQueue = [];
  let authPending = false;
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');

  function drainQueue() {
    authPending = false;
    while (msgQueue.length) {
      const raw = msgQueue.shift();
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      handleMessage(ws, msg).catch(e => console.error('WS handler error:', e));
    }
  }

  if (token && pool) {
    authPending = true;
    pool.query('SELECT id, username FROM users WHERE session_token = $1 AND disabled = false', [token])
      .then(({ rows }) => {
        if (rows.length) { ws.userId = rows[0].id; ws.username = rows[0].username; }
      })
      .catch(e => console.error('WS token verify error:', e.message))
      .finally(drainQueue);
  }

  ws.on('message', raw => {
    if (authPending) { msgQueue.push(raw); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleMessage(ws, msg).catch(e => console.error('WS handler error:', e));
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.role === 'spectator') {
      room.spectators = (room.spectators || []).filter(s => s !== ws);
      return;
    }
    const op = ws.role === 'p1' ? 'p2' : 'p1';
    send(room[op], { type: 'opponent_disconnected' });
    if (room.phase !== 'done') rooms.delete(ws.roomCode);
  });
});

/* 已登入且DB可用 → 讀帳號持久收藏庫（含損壞自動修復）；匿名玩家/沒有pool/讀取失敗 → 原本的 randomRoster()，
   這個fallback必須是今天原本的路徑，確保匿名玩家（以及帳號功能出狀況時）行為完全不變 */
async function getRosterForConnection(ws) {
  if (ws.userId && pool) {
    try {
      return await loadUserTeam(ws.userId);
    } catch (e) {
      console.error('loadUserTeam failed, falling back to randomRoster:', e.message);
      return randomRoster();
    }
  }
  return randomRoster();
}

async function handleMessage(ws, msg) {
    const { type } = msg;

    /* ── Lobby ── */
    if (type === 'create_room') {
      const code   = genCode();
      const roster = await getRosterForConnection(ws);
      const room   = { code, p1: ws, p2: null, phase: 'waiting', p1Roster: roster, p2Roster: null, p1Team: null, p2Team: null, p1Ready: false, p2Ready: false, G: null, p1Rerolls: 0, p2Rerolls: 0, p1TeamEdits: 0, p2TeamEdits: 0, p1EditCandidates: null, p2EditCandidates: null, coinFlip: null, p1UserId: ws.userId ?? null, p2UserId: null, p1Username: ws.username ?? null, p2Username: null, spectators: [] };
      rooms.set(code, room);
      ws.roomCode = code; ws.role = 'p1';
      send(ws, { type: 'room_created', code, role: 'p1', roster });
      return;
    }

    if (type === 'join_room') {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room)     { send(ws, { type: 'error', message: '找不到房間，請確認代碼' }); return; }
      if (room.p2) {
        // 房間已滿（兩名玩家都在）→ 第三個輸入同一組代碼的人改成加入觀戰，純唯讀
        room.spectators = room.spectators || [];
        room.spectators.push(ws);
        ws.roomCode = code; ws.role = 'spectator';
        send(ws, { type: 'spectate_joined', phase: room.phase, state: room.G || null });
        return;
      }
      room.p2       = ws;
      ws.roomCode   = code; ws.role = 'p2';
      room.p2Roster = await getRosterForConnection(ws);
      room.p2UserId = ws.userId ?? null;
      room.p2Username = ws.username ?? null;
      room.phase    = 'selecting';
      send(ws,      { type: 'joined', role: 'p2', roster: room.p2Roster, opponentUsername: room.p1Username });
      send(room.p1, { type: 'opponent_joined', username: room.p2Username });
      return;
    }

    const room = rooms.get(ws.roomCode);
    if (!room) { send(ws, { type: 'error', message: '房間已不存在，請重新建立房間' }); return; }
    const role = ws.role;

    // 觀眾聊天——刻意放在下面「觀戰者純唯讀」的擋板之前，因為這是唯一一種觀眾可以送出的訊息類型；
    // 反過來只允許真正的觀眾使用（role!=='spectator' 就忽略），玩家發言走原本的 chat 類型。
    if (type === 'spectator_chat') {
      if (role !== 'spectator') return;
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 80) : '';
      if (!text) return;
      const now = Date.now();
      if (ws.lastSpecChatAt && now - ws.lastSpecChatAt < 1500) return; // 輕量節流，避免洗頻
      ws.lastSpecChatAt = now;
      broadcast(room, { type: 'spectator_chat', username: ws.username || '路人觀眾', text });
      return;
    }
    if (role === 'spectator') return; // 觀戰者純唯讀，房間內的任何動作訊息一律忽略

    /* ── Team select ── */
    if (type === 'select_team') {
      const roster   = role === 'p1' ? room.p1Roster : room.p2Roster;
      const selected = (msg.indices || []).map(i => roster[i]).filter(Boolean);
      if (selected.length !== 3) { send(ws, { type: 'error', message: '請選擇 3 隻寶可夢' }); return; }
      if (new Set(selected.map(p => hpBand(p.hp))).size !== 3) { send(ws, { type: 'error', message: '請從三個血量區間（200-249／250-309／310+）各選 1 隻出戰' }); return; }
      if (role === 'p1') { room.p1Team = selected; room.p1Ready = true; }
      else               { room.p2Team = selected; room.p2Ready = true; }
      const op = role === 'p1' ? 'p2' : 'p1';
      send(room[op], { type: 'opponent_ready' });
      if (room.p1Ready && room.p2Ready) {
        const startLog = [];
        room.G     = buildG(room, startLog);
        room.phase = 'battle';
        broadcast(room, { type: 'battle_start', state: room.G, coinFlip: room.coinFlip, log: startLog });
      }
      return;
    }

    if (type === 'reroll') {
      if (room.phase !== 'selecting' && room.phase !== 'waiting') { send(ws, { type: 'error', message: '目前階段無法重新生成' }); return; }
      const key = `${role}Rerolls`;
      if (room[key] >= 1) { send(ws, { type: 'error', message: '重新生成次數已用完！' }); return; }
      room[key]++;
      const newRoster = randomRoster();
      room[`${role}Roster`] = newRoster;
      send(ws, { type: 'roster_update', roster: newRoster, rerollsLeft: 1 - room[key] });
      return;
    }

    /* 已登入玩家專用（取代匿名玩家的reroll）：生成6隻候補，玩家自選要換掉收藏庫裡的哪幾隻，
       每場比賽前最多1次（2026-07-20從3次改成1次），跟reroll用一樣的次數模型（生成候補本身就算用掉1次，
       不管最後有沒有真的換） */
    if (type === 'edit_team') {
      if (!ws.userId || !pool) { send(ws, { type: 'error', message: '請先登入才能編輯隊伍' }); return; }
      if (room.phase !== 'selecting' && room.phase !== 'waiting') { send(ws, { type: 'error', message: '目前階段無法編輯隊伍' }); return; }
      const key = `${role}TeamEdits`;
      if (room[key] >= 1) { send(ws, { type: 'error', message: '編輯隊伍次數已用完！' }); return; }
      room[key]++;
      const candidateIds = generatePlayerPool();
      const candidates = candidateIds.map(id => POKEMON.find(p => p.id === id));
      room[`${role}EditCandidates`] = candidates;
      send(ws, { type: 'team_edit_candidates', candidates, editsLeft: 1 - room[key] });
      return;
    }

    if (type === 'confirm_team_edit') {
      if (!ws.userId || !pool) { send(ws, { type: 'error', message: '請先登入才能編輯隊伍' }); return; }
      const candKey = `${role}EditCandidates`;
      const candidates = room[candKey];
      if (!candidates) { send(ws, { type: 'error', message: '請先點編輯隊伍生成候補' }); return; }
      const rosterKey = `${role}Roster`;
      const swaps = Array.isArray(msg.swaps) ? msg.swaps : [];
      const usedSlots = new Set(), usedCandidateIds = new Set();
      for (const s of swaps) {
        // slotIdx上限改成動態依目前收藏庫實際長度（2026-07-20後隊伍不再固定6隻，靠捕捉養到3~10隻不等）
        if (!s || typeof s.slotIdx !== 'number' || s.slotIdx < 0 || s.slotIdx >= room[rosterKey].length) { send(ws, { type: 'error', message: '無效的隊伍位置' }); return; }
        if (!candidates.some(p => p.id === s.candidatePokemonId)) { send(ws, { type: 'error', message: '無效的候補寶可夢' }); return; }
        if (usedSlots.has(s.slotIdx) || usedCandidateIds.has(s.candidatePokemonId)) { send(ws, { type: 'error', message: '每個位置/候補只能用一次' }); return; }
        usedSlots.add(s.slotIdx); usedCandidateIds.add(s.candidatePokemonId);
      }
      const roster = [...room[rosterKey]];
      for (const s of swaps) {
        roster[s.slotIdx] = candidates.find(p => p.id === s.candidatePokemonId);
      }
      // 換完之後收藏庫必須仍涵蓋三個血量區間，否則玩家會卡在選隊畫面湊不出合法出戰組合
      if (new Set(roster.map(p => hpBand(p.hp))).size !== 3) {
        send(ws, { type: 'error', message: '此編輯會讓收藏庫湊不出三個血量區間，請調整換入的候補' });
        return;
      }
      room[rosterKey] = roster;
      room[candKey] = null;
      try {
        await pool.query(
          `INSERT INTO teams (user_id, pokemon_ids) VALUES ($1, $2)
           ON CONFLICT (user_id) DO UPDATE SET pokemon_ids = $2, updated_at = NOW()`,
          [ws.userId, roster.map(p => p.id)]
        );
      } catch (e) {
        console.error('persist team edit error:', e.message);
        /* DB沒寫成功，但房間內roster已經更新，這場對戰照樣繼續——不讓玩家卡在team-select畫面 */
      }
      send(ws, { type: 'team_edit_confirmed', roster, editsLeft: 1 - room[`${role}TeamEdits`] });
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
      if (card.cat === 'supporter' && G[`${role}SupporterLockedThisTurn`]) {
        send(ws, { type: 'error', message: '通訊封印中，這回合無法使用支援者卡！' }); return;
      }
      if (HAND_MANIPULATION_CARDS.includes(card.id) && G[`${role}HandCardUsed`]) {
        send(ws, { type: 'error', message: '這回合已經用過抽牌／搶牌類的卡了！' }); return;
      }
      // 屬性轉換：先驗證 client 送來的屬性是合法值再消耗手牌，不信任隨便傳的字串
      if (card.id === 'type-orb' && !Object.keys(EFF).includes(msg.chosenType)) {
        send(ws, { type: 'error', message: '屬性轉換的屬性無效！' }); return;
      }

      // 瘋狂博士：需要額外的目標索引；先驗證目標合法才消耗手牌
      // targetSide 只能是 'own'（我方已陣亡）或 'enemy'（對方已陣亡），不信任其他字串
      if (card.id === 'mad-scientist') {
        if (msg.targetSide !== 'own' && msg.targetSide !== 'enemy') {
          send(ws, { type: 'error', message: '瘋狂博士目標無效！' }); return;
        }
        const mine       = G[`${role}Deck`][msg.targetOwnIdx];
        const targetDeck = msg.targetSide === 'own' ? G[`${role}Deck`] : G[`${op}Deck`];
        const target     = targetDeck[msg.targetIdx];
        if (!mine || mine.cur <= 0 || !target || target.cur > 0) {
          send(ws, { type: 'error', message: '瘋狂博士目標無效！' }); return;
        }
        hand.splice(msg.handIdx, 1);
        G[`${role}SuppUsed`] = true; G[`${role}SuppStageUsed`]++;
        const oldName = mine.name;
        Object.assign(mine, {
          id: target.id, name: target.name, type: target.type, type2: target.type2 ?? null,
          attacks: target.attacks.map(a => ({...a})), hp: target.hp, ability: target.ability ?? null,
          // 變身後的身分是target，Mega資料也要一併換成target自己的（否則Mega進化會套用變身前的舊species資料，變成不倫不類的混合體）
          mega: target.mega ? {...target.mega} : undefined, megaEvolved: target.mega ? false : undefined,
        });
        mine.cur = Math.round(target.hp * 0.5); // 變身當下只回復50% HP（原本是全滿，使用者覺得太強而調整）
        mine.status = null;
        const log = [{ text: `使用了瘋狂博士，${oldName} 變身成了 ${mine.name}！`, cls: 'special' }];
        triggerOnEnterSrv(mine, role, G, log, false);
        broadcast(room, { type: 'update', state: G, log, actor: role });
        return;
      }

      // 獵捕：強制對手一隻備戰寶可夢上場（不觸發上場特性／進場陷阱，isFieldEntry=false），
      // 並造成40點固定傷害（用attacker.type/srvEffActive計算屬性相剋）。先驗證目標合法才消耗手牌，
      // 邏輯同switcher的強制換人寫法（重置對方buff/撐住/硬幣護盾，觸發triggerOnLeaveSrv+triggerOnEnterSrv）。
      if (card.id === 'hunt') {
        const opDeck = G[`${op}Deck`];
        const target = opDeck[msg.targetIdx];
        if (!target || msg.targetIdx === G[`${op}Idx`] || target.cur <= 0) {
          send(ws, { type: 'error', message: '獵捕目標無效！' }); return;
        }
        hand.splice(msg.handIdx, 1);
        G[`${role}SuppUsed`] = true; G[`${role}SuppStageUsed`]++;
        const attacker = G[`${role}Deck`][G[`${role}Idx`]];
        const outPoke = opDeck[G[`${op}Idx`]];
        const log = [{ text: `使用了獵捕，強制讓 ${target.name} 上場！`, cls: 'special' }];
        triggerOnLeaveSrv(outPoke, op, G, log);
        G[`${op}Idx`] = msg.targetIdx;
        G[`${op}Buff`] = freshBuff();
        G[`${op}Braced`] = false;
        G[`${op}CoinShield`] = false;
        triggerOnEnterSrv(target, op, G, log, false); // 不觸發上場特性／進場陷阱

        const mult = srvEffActive(attacker.type, target.type, target.type2, G);
        const dmg = Math.max(1, Math.round(40 * mult));
        target.cur = Math.max(0, target.cur - dmg);
        log.push({ text: `${target.name} 受到了獵捕的 ${dmg} 點傷害！`, cls: 'special' });

        if (target.cur <= 0) {
          const opAlive = opDeck.filter(p => p.cur > 0).length;
          if (opAlive === 0) {
            endGame(room, role, log); return;
          }
          G.pendingKOSwitch = op; // 不改G.turn——仍然是role的行動中，op只是被迫補位，不代表輪到op的回合
        }
        broadcast(room, { type: 'update', state: G, log, actor: role });
        return;
      }

      hand.splice(msg.handIdx, 1);
      if (card.cat === 'supporter') { G[`${role}SuppUsed`] = true; G[`${role}SuppStageUsed`]++; }
      if (HAND_MANIPULATION_CARDS.includes(card.id)) G[`${role}HandCardUsed`] = true;
      if (card.cat === 'item') G[`${role}UsedItemThisTurn`] = true; // 龍捲雲系特性「機械之心」用這個判斷

      // 搏命：雙方場上寶可夢同歸於盡
      if (card.id === 'sacrifice') {
        const active   = G[`${role}Deck`][G[`${role}Idx`]];
        const opActive = G[`${op}Deck`][G[`${op}Idx`]];
        active.cur = 0; opActive.cur = 0;
        const log = [{ text: `使用了搏命！雙方場上的寶可夢同歸於盡了！`, cls: 'special' }];
        const roleAlive = G[`${role}Deck`].filter(p => p.cur > 0).length;
        const opAlive   = G[`${op}Deck`].filter(p => p.cur > 0).length;
        if (roleAlive === 0 && opAlive === 0) {
          endGame(room, 'draw', log); return;
        }
        if (roleAlive === 0) {
          endGame(room, op, log); return;
        }
        if (opAlive === 0) {
          endGame(room, role, log); return;
        }
        G.pendingKOSwitch = role;
        G.pendingKOSwitchQueue = [op];
        G.turn = op; // 搏命 consumes the turn — without this, ko_switch's "did the turn actually end" check never passes and role can act again immediately
        broadcast(room, { type: 'update', state: G, log, actor: role });
        return;
      }

      const log = [];
      applyTrainer(card, role, G, log, msg.chosenType);
      broadcast(room, { type: 'update', state: G, log, actor: role });
      return;
    }

    // Discard
    if (type === 'discard') {
      if (!G[`${role}NeedsDiscard`]) return;
      const hand = G[`${role}Hand`];
      if (msg.handIdx < 0 || msg.handIdx >= hand.length) return;
      hand.splice(msg.handIdx, 1);
      G[`${role}NeedsDiscard`] = hand.length > 7;
      broadcast(room, { type: 'update', state: G, log: [], actor: role });
      return;
    }

    // Mega 進化：免費行動，不結束回合；雙方共用一條 Mega 能量槽，整場只能用一次
    if (type === 'mega_evolve') {
      if (G.turn !== role || G.pendingKOSwitch) return;
      const attacker = G[`${role}Deck`][G[`${role}Idx`]];
      if (!attacker.mega || attacker.megaEvolved || G[`${role}MegaUsed`] || G[`${role}MegaEnergy`] < 20) return;
      if (G[`${role}MegaSealedTurns`] > 0) { send(ws, { type: 'error', message: `Mega進化被封印中，還剩 ${G[`${role}MegaSealedTurns`]} 回合` }); return; }
      attacker.id = attacker.mega.spriteId;
      attacker.type = attacker.mega.type;
      attacker.type2 = attacker.mega.type2 ?? null;
      attacker.ability = { ...attacker.mega.ability };
      attacker.megaEvolved = true;
      attacker.hp = Math.round(attacker.hp * 1.2); // Mega 進化額外提升 HP 上限（比照真實種族值總和提升）
      attacker.cur = attacker.hp; // Mega 進化時補滿血
      attacker.status = null; // 並解除異常狀態
      applyMegaMoveset(attacker); // 4招消耗壓到5~7、傷害拉到tier對應的高傷害區間
      G[`${role}MegaUsed`] = true;
      const log = [{ text: `${attacker.name} Mega 進化了！HP 全滿，異常狀態解除！`, cls: 'special' }];
      triggerOnEnterSrv(attacker, role, G, log, false);
      broadcast(room, { type: 'update', state: G, log, actor: role, megaEvolved: true });
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
      const atkCost = effectiveCostSrv(atk, defender, G, aBuff);
      if ((G[`${role}Energy`] || 0) < atkCost) { send(ws, { type:'error', message:'能量不足，無法使用這個招式' }); return; }

      const log = [];
      const sResult = handleStatus(attacker, log, atk.type);

      if (sResult.died) {
        // Attacker KO'd by own status (confusion self-hit — poison/burn no longer resolve here).
        // Attempting to attack (even one that backfired) still consumes the turn, same as the
        // reflect-death case below — previously G.turn was left unchanged here too, letting the
        // same role act again immediately after picking a replacement (same bug class as the
        // reflect fix just below, see project memory for the 2026-07-02 note this was a known,
        // deliberately-unaddressed quirk at the time).
        const alive = G[`${role}Deck`].filter(p => p.cur > 0).length;
        if (alive === 0) {
          endGame(room, op, log); return;
        }
        G.pendingKOSwitch = role;
        G.turn = op;
        G.round++;
        G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; // all expire if this role never actually attacked
        drawForRole(G, op);
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      if (sResult.skipped) {
        // Attack was blocked (sleep/paralysis/freeze) — still apply the attacker's own
        // end-of-turn poison/burn tick before handing the turn to the opponent.
        applyEndOfTurnStatusSrv(attacker, log, G, role);
        if (attacker.cur <= 0) {
          const alive = G[`${role}Deck`].filter(p => p.cur > 0).length;
          if (alive === 0) {
            endGame(room, op, log); return;
          }
          G.pendingKOSwitch = role;
          broadcast(room, { type: 'update', state: G, log, actor: role }); return;
        }
        G.turn = op;
        G[`${role}SuppUsed`] = false;
        G[`${role}HandCardUsed`] = false;
        G[`${role}FreeSwitch`] = false;
        G[`${role}SwitchedThisTurn`] = false;
        G[`${op}SwitchGuard`] = false; // guard only lasts one enemy turn, even if that turn was skipped
        G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; // all expire if opponent never attacked (status skip)
        drawForRole(G, op);
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      const switchGuardMult = G[`${op}SwitchGuard`] ? 0.96 : 1;
      G[`${op}SwitchGuard`] = false; // consumed by this incoming attack
      G[`${role}Energy`] -= atkCost;
      // 米立龍系特性「指揮」：上一隻我方寶可夢離場留下的能量折扣，只在真正的攻擊招式上生效（輔助技能不算）
      if (!atk.support && G[`${role}LegacyBuff`]) {
        const refund = Math.round(atkCost * (1 - G[`${role}LegacyBuff`].energyMult));
        G[`${role}Energy`] = Math.min(20, G[`${role}Energy`] + refund);
      }
      if (atk.support) {
        executeSupportMoveSrv(attacker, defender, atk, role, op, G, log);
      } else {
        if (atk.bonusEnergy) G[`${role}BonusEnergyNextTurn`] = (G[`${role}BonusEnergyNextTurn`] || 0) + atk.bonusEnergy;
        doAttack(attacker, defender, atk, aBuff, dBuff, log, G, switchGuardMult);
      }
      G[`${role}SuppUsed`]  = false;
      G[`${role}HandCardUsed`] = false;
      G[`${role}FreeSwitch`] = false;
      G[`${role}SwitchedThisTurn`] = false;

      // Attacker's own end-of-turn poison/burn tick, applied now that its attack has resolved —
      // but only if the attack exchange itself didn't already kill it (nothing to tick on a
      // fainted Pokémon). Applying it before computing attackerDied means the existing
      // both-died/attacker-only/defender-only/neither branching below automatically handles a
      // "survived the hit but then died to poison" case the same way it already handles recoil.
      if (attacker.cur > 0) applyEndOfTurnStatusSrv(attacker, log, G, role);

      const attackerDied = attacker.cur <= 0; // reflect bounce, defender-ability recoil (粗糙皮膚), or the poison/burn tick just above
      const defenderDied = defender.cur <= 0;

      if (attackerDied && defenderDied) {
        // Simultaneous KO — defender-ability recoil can kill the attacker in the same hit that kills
        // the defender. Must check both teams' alive counts together; checking attacker alone (and
        // returning) would silently drop a defender death that happened in the same exchange.
        const roleAlive = G[`${role}Deck`].filter(p => p.cur > 0).length;
        const opAlive    = G[`${op}Deck`].filter(p => p.cur > 0).length;
        if (roleAlive === 0 && opAlive === 0) {
          endGame(room, 'draw', log); return;
        }
        if (roleAlive === 0) {
          endGame(room, op, log); return;
        }
        if (opAlive === 0) {
          endGame(room, role, log, { atkType: atk.type }); return;
        }
        // Both sides have reserves — both must pick a replacement, attacker's side first.
        // Attacker's turn concludes (their attack landed successfully) — turn passes to op,
        // matching the ordinary single-KO case below, so op gets their draw once both are resolved.
        G.pendingKOSwitch = role;
        G.pendingKOSwitchQueue = [op];
        G.turn = op;
        broadcast(room, { type: 'update', state: G, log, actor: role, atkType: atk.type }); return;
      }

      if (attackerDied) {
        // Reflected damage (or defender-ability recoil) killed the attacker's own Pokémon —
        // the attack still landed, so the turn passes to the opponent same as any other
        // successful attack; the attacker separately needs to pick a replacement via
        // pendingKOSwitch, but that's independent of whose turn it now is. Previously G.turn
        // was left unchanged here (still the attacker's), so after picking a replacement the
        // attacker could immediately act again — reported by the user as "反彈致死後應該換
        //對方回合".
        const alive = G[`${role}Deck`].filter(p => p.cur > 0).length;
        if (alive === 0) {
          endGame(room, op, log); return;
        }
        G.pendingKOSwitch = role;
        G.turn = op;
        G.round++;
        drawForRole(G, op);
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      if (defenderDied) {
        const opAlive = G[`${op}Deck`].filter(p => p.cur > 0).length;
        if (opAlive === 0) {
          endGame(room, role, log, { atkType: atk.type }); return;
        }
        G.pendingKOSwitch = op;
        G.turn = op;
        // Don't draw for op yet — draw after they ko_switch (start of their turn)
      } else {
        G.turn = op;
        G.round++;
        drawForRole(G, op);
      }
      broadcast(room, { type: 'update', state: G, log, actor: role, atkType: atk.type }); return;
    }

    // Standby (skip attack, draw 1 supporter card)
    if (type === 'standby') {
      if (G.turn !== role || G.pendingKOSwitch) return;
      if (G[`${role}NeedsDiscard`]) return;
      const active = G[`${role}Deck`][G[`${role}Idx`]];
      const log = [];
      tickNonAttackStatusSrv(active, log); // sleep/freeze/confusion still count down even when standing by
      applyEndOfTurnStatusSrv(active, log, G, role); // poison/burn still ticks even when standing by
      const supporters = TRAINERS.filter(c => c.cat === 'supporter');
      const card = supporters[Math.floor(Math.random() * supporters.length)];
      G[`${role}Hand`].push(card);
      G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;
      log.push({ text: `選擇待機，${role === 'p1' ? 'P1' : 'P2'} 抽到【${card.name}】！`, cls: 'system' });

      if (active.cur <= 0) {
        const alive = G[`${role}Deck`].filter(p => p.cur > 0).length;
        if (alive === 0) {
          endGame(room, op, log); return;
        }
        G.pendingKOSwitch = role;
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      G[`${role}SuppUsed`] = false;
      G[`${role}HandCardUsed`] = false;
      G[`${role}FreeSwitch`] = false;
      G[`${role}SwitchedThisTurn`] = false;
      G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; // all expire when opponent skips attack
      G[`${role}Buff`].typeOverride = null; // orb effect expires — turn ends without attacking
      G.turn = op;
      G.round++;
      drawForRole(G, op);
      broadcast(room, { type: 'update', state: G, log, actor: role }); return;
    }

    // Switch (ends the turn, unless 撤退背心 granted a free switch); switched-in Pokémon takes ×0.96 damage this turn
    if (type === 'switch') {
      if (G.turn !== role || G.pendingKOSwitch) return;
      if (G[`${role}NeedsDiscard`]) return;
      if (G[`${role}SwitchedThisTurn`]) return; // only one switch per turn, free or not
      const deck   = G[`${role}Deck`];
      const curIdx = G[`${role}Idx`];
      const newIdx = msg.deckIdx;
      if (newIdx === curIdx || !deck[newIdx] || deck[newIdx].cur <= 0) return;

      const usedFreeSwitch = G[`${role}FreeSwitch`];
      const outPoke = deck[curIdx];
      if (outPoke.status?.type === 'confusion') outPoke.status = null;
      G[`${role}Idx`] = newIdx;
      G[`${role}Buff`].typeOverride = null; // orb effect expires — turn ends without attacking
      G[`${role}SwitchGuard`] = true; // this turn's incoming damage ×0.96
      G[`${role}FreeSwitch`] = false;
      G[`${role}SwitchedThisTurn`] = true;

      if (usedFreeSwitch) {
        const log = [{ text: `換上了 ${deck[newIdx].name}！（撤退背心：不消耗回合）本回合傷害減免中…`, cls: 'player' }];
        triggerOnLeaveSrv(outPoke, role, G, log);
        triggerOnEnterSrv(deck[newIdx], role, G, log);
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      G[`${role}SuppUsed`] = false;
      G[`${role}HandCardUsed`] = false;
      G[`${role}SwitchedThisTurn`] = false; // this turn is over — clear it so role can switch again on their *next* turn
      G.turn = op;
      G.round++;
      G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; // all expire if opponent never attacked (switched instead)
      drawForRole(G, op);
      const log = [{ text: `換上了 ${deck[newIdx].name}！本回合傷害減免中…`, cls: 'player' }];
      triggerOnLeaveSrv(outPoke, role, G, log);
      triggerOnEnterSrv(deck[newIdx], role, G, log);
      broadcast(room, { type: 'update', state: G, log, actor: role }); return;
    }

    // KO switch (forced switch after being KO'd)
    if (type === 'ko_switch') {
      if (G.pendingKOSwitch !== role) return;
      const deck   = G[`${role}Deck`];
      const newIdx = msg.deckIdx;
      if (!deck[newIdx] || deck[newIdx].cur <= 0) return;

      const fainted = deck[G[`${role}Idx`]];
      const log = [{ text: `${deck[newIdx].name} 上場！`, cls: 'system' }];
      triggerOnLeaveSrv(fainted, role, G, log);
      G[`${role}Idx`] = newIdx;
      G.pendingKOSwitch = null;
      triggerOnEnterSrv(deck[newIdx], role, G, log);

      if (G.pendingKOSwitchQueue?.length) {
        G.pendingKOSwitch = G.pendingKOSwitchQueue.shift();
        if (!G.pendingKOSwitchQueue.length) delete G.pendingKOSwitchQueue;
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      // Only draw if this switch actually starts role's turn (not a same-turn 搏命 replacement)
      if (G.turn === role) drawForRole(G, role);
      broadcast(room, { type: 'update', state: G, log, actor: role }); return;
    }

    if (type === 'discard_trade') {
      if (G.turn !== role || G.pendingKOSwitch) return;
      const hand = G[`${role}Hand`];
      const indices = msg.indices;
      // 2026-07-22應使用者要求重新設計：棄1張→競技場卡或+5能量；棄2張→道具卡或解除異常狀態
      // （原本固定要棄2張、3選1）。cardType合法性依棄牌張數而不同，伺服器端驗證兩者搭配是否合法，
      // 不信任client傳來的組合（避免用「棄1張」拿到本該棄2張才能換的道具卡）。
      if (!Array.isArray(indices) || indices.length < 1 || indices.length > 2) return;
      if (indices.some(i => typeof i !== 'number' || i < 0 || i >= hand.length)) return;
      if (new Set(indices).size !== indices.length) return;
      const cardType = msg.cardType;
      const allowedTypes = indices.length === 1 ? ['stadium', 'energy'] : ['item', 'cure'];
      if (!allowedTypes.includes(cardType)) return;
      const sorted = [...indices].sort((a,b) => b-a);
      sorted.forEach(i => hand.splice(i, 1));
      if (cardType === 'energy') {
        const gain = Math.min(20 - G[`${role}Energy`], 5);
        G[`${role}Energy`] = Math.min(20, G[`${role}Energy`] + 5);
        G[`${role}NeedsDiscard`] = hand.length > 7;
        const log = [{ text: `棄牌換能量！回復了 ${gain} 點能量！（現在 ${G[`${role}Energy`]}/20）`, cls: 'system' }];
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }
      if (cardType === 'cure') {
        const active = G[`${role}Deck`][G[`${role}Idx`]];
        let log;
        if (active.status) {
          const effectName = STATUS_ZH[active.status.type] || active.status.type;
          active.status = null;
          log = [{ text: `棄牌解除了${active.name}的${effectName}！`, cls: 'system' }];
        } else {
          log = [{ text: `${active.name}目前沒有異常狀態。`, cls: 'system' }];
        }
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }
      const pool = TRAINERS.filter(c => c.cat === cardType);
      const newCard = weightedPick(pool);
      hand.push(newCard);
      G[`${role}NeedsDiscard`] = hand.length > 7;
      const log = [{ text: `棄牌換卡！【${newCard.name}】到手！`, cls: 'system' }];
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
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      session_token TEXT,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      disabled BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      badge_id TEXT
    )`);
    // 舊資料庫（表已存在）不會補上新欄位，CREATE TABLE IF NOT EXISTS 對既有表是no-op——用ADD COLUMN IF NOT EXISTS補齊
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_id TEXT`);
    await pool.query(`CREATE TABLE IF NOT EXISTS teams (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      pokemon_ids INTEGER[] NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS weekly_stats (
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      week_start_date DATE NOT NULL,
      wins INTEGER NOT NULL DEFAULT 0,
      losses INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, week_start_date)
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pets (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      species_id INTEGER NOT NULL,
      happiness INTEGER NOT NULL DEFAULT 50,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_interaction_at TIMESTAMPTZ,
      coins INTEGER NOT NULL DEFAULT 0,
      last_coin_grant_date DATE
    )`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS coins INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS last_coin_grant_date DATE`);
    // 飢餓值：DEFAULT NOW()讓補欄位當下就是錨點，不會讓舊寵物一登入就補算一大段過去的衰減
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS hunger INTEGER NOT NULL DEFAULT 100`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS last_fed_at TIMESTAMPTZ DEFAULT NOW()`);
    // 商城道具——買了就永久持有（不是消耗品）。原本slot是3選1固定插槽enum，2026-07-21改成
    // 自由拖曳座標（pos_x/pos_y，0~1標準化分數，NULL=放在道具欄裡還沒擺進房間）——
    // 舊的slot欄位刻意保留不刪（比照users.badge_id的做法，避免破壞性DROP COLUMN），新程式碼完全不再讀寫它。
    await pool.query(`CREATE TABLE IF NOT EXISTS pet_decorations (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      slot TEXT,
      acquired_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, item_id)
    )`);
    await pool.query(`ALTER TABLE pet_decorations ADD COLUMN IF NOT EXISTS pos_x REAL`);
    await pool.query(`ALTER TABLE pet_decorations ADD COLUMN IF NOT EXISTS pos_y REAL`);
    // 釣魚——用SERIAL PRIMARY KEY而不是像pet_decorations那樣用(user_id,item_id)複合主鍵，
    // 因為魚可以重複釣到同一種，每次都是新的一列，不是「擁有一件獨特道具」那種語意。
    // 必須排在下面ALTER TABLE pets之前，因為display_fish_id的外鍵參照到這張表。
    await pool.query(`CREATE TABLE IF NOT EXISTS pet_fish (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fish_type TEXT NOT NULL,
      caught_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS display_fish_id INTEGER REFERENCES pet_fish(id) ON DELETE SET NULL`);
    // 「我的最愛」——標記後sell()端點會拒絕賣出，防止誤賣（2026-07-22新增）
    await pool.query(`ALTER TABLE pet_fish ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE`);
    // 魚圖鑑用的「曾經釣到過」永久紀錄——跟pet_fish（目前擁有的魚）分開，賣光某種魚後圖鑑
    // 不會因此退回「未發現」，這是刻意的設計（見魚圖鑑端點的說明）
    await pool.query(`CREATE TABLE IF NOT EXISTS pet_fish_discovered (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      fish_type TEXT NOT NULL,
      discovered_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, fish_type)
    )`);
    // 捕捉寶可夢用的球——3種固定類型，跟coins一樣是pets的flat欄位（不像魚會累積很多種，球只需要計數）
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS ball_normal INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS ball_great INTEGER NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS ball_ultra INTEGER NOT NULL DEFAULT 0`);
    // 魚缸／魚圖鑑聲納這兩個固定裝置的自由拖曳座標——NULL代表玩家還沒拖過，前端沿用固定的預設位置
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS fish_tank_pos_x REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS fish_tank_pos_y REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS fish_dex_pos_x REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS fish_dex_pos_y REAL`);
    // 多徽章擁有——跟pet_decorations同一套「擁有+可選擺放位置」語意（pos_x/y為NULL=擁有但沒展示在房間裡）。
    // 取代舊的users.badge_id單一欄位（一人只能有一個、指定新的會整個覆蓋掉舊的）；badge_id欄位保留不刪。
    await pool.query(`CREATE TABLE IF NOT EXISTS user_badges (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      badge_id TEXT NOT NULL,
      pos_x REAL,
      pos_y REAL,
      awarded_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, badge_id)
    )`);
    // 一次性migration追蹤表——沒有ORM/migration工具，用一列「已套用哪些一次性migration」的標記表，
    // 用INSERT...ON CONFLICT DO NOTHING RETURNING判斷這次伺服器啟動是不是第一次跑到這條migration
    await pool.query(`CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT NOW())`);
    await runMigrationOnce('2026-07-20-catch-system-reset', async () => {
      // 既有帳號金幣統一設成1000（捕捉機制的起始金幣基準）
      await pool.query('UPDATE pets SET coins = 1000');
      // 既有隊伍（原本固定6隻）裁到3隻，三個血量區間各保留隨機1隻——比照 randomRoster 的分組邏輯，
      // 但這裡是從玩家「現有」陣容裡挑，不是從整個圖鑑重新抽
      const { rows } = await pool.query('SELECT user_id, pokemon_ids FROM teams');
      for (const row of rows) {
        const mons = row.pokemon_ids.map(id => POKEMON.find(p => p.id === id)).filter(Boolean);
        const bands = [[], [], []];
        for (const p of mons) bands[hpBand(p.hp)].push(p);
        const trimmed = bands.map(b => b.length ? b[Math.floor(Math.random() * b.length)] : null).filter(Boolean);
        if (trimmed.length === 3) {
          await pool.query('UPDATE teams SET pokemon_ids = $1 WHERE user_id = $2', [trimmed.map(p => p.id), row.user_id]);
        }
        // 湊不出三區間各1隻的損壞資料就跳過——loadUserTeam 既有的「length===0才修復」邏輯這裡不適用
        // （length不是0），但下次玩家連線時如果真的損壞會在其他既有的驗證路徑被處理，不在這裡強行修
      }
    });
    // 魚圖鑑上線前就已經釣到的魚，回填一次discovered紀錄——不然玩家明明釣過某種魚，
    // 圖鑑卻顯示「未發現」（灰階），體驗上不合理
    await runMigrationOnce('2026-07-22-fish-dex-backfill', async () => {
      await pool.query(`
        INSERT INTO pet_fish_discovered (user_id, fish_type)
        SELECT DISTINCT user_id, fish_type FROM pet_fish
        ON CONFLICT DO NOTHING
      `);
    });
    // 既有玩家的單一badge_id搬進新的user_badges多對多表——pos給舊版#badge-slot固定位置
    // （房間右上角，比照舊CSS的right:14px/top:14px换算成標準化分數）,讓既有玩家升級後
    // 徽章視覺位置大致不變。舊的users.badge_id欄位保留不刪，新程式碼不再讀它。
    await runMigrationOnce('2026-07-21-multi-badge-migration', async () => {
      await pool.query(`
        INSERT INTO user_badges (user_id, badge_id, pos_x, pos_y)
        SELECT id, badge_id, 0.90, 0.12 FROM users WHERE badge_id IS NOT NULL
        ON CONFLICT DO NOTHING
      `);
    });
    // 既有的3種固定插槽裝飾換算成對應的標準化座標，視覺上盡量貼近原本位置
    // （牆面插槽在左上角、地板中在下方置中、地板右在右下角）
    await runMigrationOnce('2026-07-21-decor-freeform-position-migration', async () => {
      const SLOT_POS = {
        'slot-wall': [0.08, 0.08],
        'slot-floor-mid': [0.5, 0.92],
        'slot-floor-right': [0.92, 0.92],
      };
      for (const [slot, [x, y]] of Object.entries(SLOT_POS)) {
        await pool.query(
          'UPDATE pet_decorations SET pos_x = $1, pos_y = $2 WHERE slot = $3 AND pos_x IS NULL',
          [x, y, slot]
        );
      }
    });
    console.log('PostgreSQL connected');
  } catch (e) {
    console.warn('PostgreSQL not available, running without DB:', e.message);
  }
}

async function runMigrationOnce(name, fn) {
  const { rows } = await pool.query('INSERT INTO migrations (name) VALUES ($1) ON CONFLICT DO NOTHING RETURNING name', [name]);
  if (!rows.length) return; // 已經套用過，跳過
  try {
    await fn();
    console.log(`migration applied: ${name}`);
  } catch (e) {
    console.error(`migration failed: ${name}`, e.message);
    await pool.query('DELETE FROM migrations WHERE name = $1', [name]); // 失敗就撤回標記，下次啟動重試
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  await initDB();
  console.log(`Server: http://localhost:${PORT}`);
});
