'use strict';
const express   = require('express');
const http      = require('http');
const { WebSocketServer } = require('ws');
const { Pool }  = require('pg');
const crypto    = require('crypto');
const util      = require('util');
const fs        = require('fs');
const path      = require('path');

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
  /* ── Tier 1 弱 ── */
  { mega:{spriteId:10033, type:'grass', type2:'poison', ability:{id:'thick-fat-pure', name:'厚脂肪', trigger:'onDefend', desc:'受到的傷害-50，HP 低於 1/3 時，招式傷害額外 ×1.2'}}, id:3,   name:'妙蛙花',     type:'grass',    type2:'poison',  hp:250, tier:1, ability:{id:'blaze-boost-pure', name:'茂盛', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，並且HP 低於 1/3 時，招式傷害額外 ×1.1'}, attacks:[{name:'逆鱗吸能擊',dmg:46,cost:1,type:'dragon',rider:'energy-steal'},{name:'大地之力',dmg:65,cost:5,type:'ground',status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'藤鞭',dmg:72,cost:5,type:'grass',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'惡意突刺',dmg:91,cost:7,type:'poison',ignoreReflect:true,status:{effect:'burn', chance:0.4},bonusVsType:'electric',ignoreShield:true}]},
  { mega:{spriteId:10038, type:'ghost', type2:'poison', ability:{id:'shadow-tag-pierce', name:'踩影', trigger:'onAttack', desc:'攻擊不會被閃避也不會被減傷'}}, id:94,  name:'耿鬼',       type:'ghost',    type2:'poison',  hp:220, tier:1, ability:{id:'poison-heal', name:'毒療', trigger:'onEnter', desc:'擁有中毒狀態，並且中毒時每回合回復 70HP，而非扣血'}, attacks:[{name:'催眠術',dmg:50,cost:2,type:'psychic',rider:'mega-charge',status:{effect:'sleep', chance:0.5},megaBoost:true,bonusEnergy:6,status2:{effect:'confusion',chance:0.5}},{name:'幽靈之爪',dmg:80,cost:6,type:'ghost',rider:'type-draw',status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'confusion',chance:0.4}},{name:'污泥炸彈',dmg:100,cost:8,type:'poison',megaBoost:true,bonusEnergy:7},{name:'妖精護甲擊',dmg:49,cost:2,type:'fairy',rider:'self-cure'}]},
  { id:68,  name:'怪力',       type:'fighting', hp:260, tier:1, ability:{id:'fighting-domain', name:'鬥氣支配', trigger:'onEnter', desc:'上場時場地切換為羅馬鬥技場；格鬥屬性攻擊傷害額外 +40'}, attacks:[{name:'幽靈之爪',dmg:48,cost:2,type:'ghost',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'岩石滑落',dmg:68,cost:5,type:'rock',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'疾風強奪擊',dmg:75,cost:5,type:'flying',ignoreReflect:true,rider:'card-steal'},{name:'動感拳',dmg:94,cost:7,type:'fighting',selfHeal:0.21,bonusVsType:'psychic',ignoreReflect:true}]},
  { mega:{spriteId:10037, type:'psychic', type2:null, ability:{id:'trace', name:'複製', trigger:'onEnter', desc:'上場時獲得對手上回合使用過的道具卡（Mega 進化成這隻寶可夢也算這隻寶可夢上場）'}}, id:65,  name:'胡地',       type:'psychic',  hp:200, tier:1, ability:{id:'sync-status', name:'同步', trigger:'onDefend', desc:'被賦予負面狀態時，也給予對手相同的負面狀態'}, attacks:[{name:'暗影球',dmg:44,cost:0,type:'ghost',rider:'self-cure',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'poison',chance:0.4}},{name:'寶石爆破',dmg:40,cost:0,type:'rock',ignoreReflect:true,status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:4,status2:{effect:'poison',chance:0.4}},{name:'超能力',dmg:87,cost:7,type:'psychic',megaBoost:true,bonusEnergy:4},{name:'冰霜吸血擊',dmg:71,cost:5,type:'ice',rider:'type-draw'}]},
  { mega:{spriteId:10304, type:'electric', type2:null, ability:{id:'shock-stadium-dodge', name:'電氣場地', trigger:'onEnter', desc:'上場時場地切換為雷雲庇護所，並且有 20% 機率完全閃避攻擊'}}, id:26,  name:'雷丘',       type:'electric', hp:200, tier:1, ability:{id:'static-paralyze-dual', name:'靜電', trigger:'onEnter', desc:'上場時麻痺對手，並且攻擊附帶電屬性傷害（計算傷害時，招式屬性以及電屬性攻擊擇優進行計算）'}, attacks:[{name:'橫衝直撞',dmg:43,cost:0,type:'normal',rider:'type-draw',megaBoost:true,bonusEnergy:4},{name:'石刃',dmg:40,cost:0,type:'rock',rider:'energy-steal',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'burn',chance:0.4}},{name:'十萬伏特',dmg:86,cost:7,type:'electric',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:4,bonusVsType:'bug'},{name:'逆鱗威壓擊',dmg:70,cost:5,type:'dragon',rider:'mega-charge'}]},
  { mega:{spriteId:10076, type:'steel', type2:'psychic', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:376, name:'巨金怪',     type:'steel',    type2:'psychic', hp:260, tier:1, ability:{id:'solid-rock-flat', name:'硬岩', trigger:'onDefend', desc:'受到的傷害-30'}, attacks:[{name:'隕石衝擊',dmg:48,cost:2,type:'rock',rider:'type-draw',megaBoost:true,bonusEnergy:6},{name:'冰霜吸能擊',dmg:72,cost:6,type:'ice',rider:'energy-steal'},{name:'念力',dmg:79,cost:6,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'子彈拳',dmg:99,cost:8,type:'steel',ignoreReflect:true,selfHeal:0.25,bonusVsType:'fire',ignoreShield:true}]},
  { mega:{spriteId:10059, type:'fighting', type2:'steel', ability:{id:'adaptability-major', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.4（原本 ×1.1）'}}, id:448, name:'路卡利歐',   type:'fighting', type2:'steel',   hp:220, tier:1, ability:{id:'guts-cure-burst', name:'堅韌', trigger:'onAttack', desc:'回合開始時，若帶有異常狀態，解除異常狀態並且下次攻擊傷害 +20'}, attacks:[{name:'灼熱護甲擊',dmg:54,cost:2,type:'fire',rider:'energy-steal'},{name:'暗影球',dmg:50,cost:2,type:'ghost',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'龍之脈動',dmg:80,cost:6,type:'dragon',megaBoost:true,bonusEnergy:6},{name:'金屬爪',dmg:100,cost:8,type:'steel',selfHeal:0.18,bonusVsType:'psychic',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10041, type:'water', type2:'dark', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對手特性'}}, id:130, name:'暴鯉龍',     type:'water',    type2:'flying',  hp:260, tier:1, ability:{id:'tide-vortex', name:'潮漩', trigger:'passive', desc:'對手不能交換寶可夢，回合結束時，對手有50%機率隨機棄掉一張卡牌'}, attacks:[{name:'大地強奪擊',dmg:79,cost:6,type:'ground',rider:'card-steal',ignoreReflect:true},{name:'咬碎',dmg:75,cost:6,type:'dark',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'怒風',dmg:54,cost:2,type:'flying',rider:'mega-charge',megaBoost:true,bonusEnergy:6},{name:'水砲',dmg:102,cost:8,type:'water',status:{effect:'sleep', chance:0.4},bonusVsType:'psychic'}]},
  { id:87,  name:'白海獅',     type:'water',    type2:'ice',     hp:240, tier:1, ability:{id:'legacy-boost', name:'指揮', trigger:'onDefend', desc:'受到攻擊後，下個我方回合抽取兩張道具卡，寶可夢招式傷害+50'}, attacks:[{name:'未來雷霆',dmg:44,cost:0,type:'psychic',ignoreReflect:true,status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'paralysis',chance:0.4}},{name:'荒草吸血擊',dmg:68,cost:5,type:'grass',rider:'mega-charge'},{name:'大浪',dmg:64,cost:5,type:'water',megaBoost:true,bonusEnergy:4,rider:'energy-steal'},{name:'冷凍光線',dmg:94,cost:7,type:'ice',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting'}]},
  { id:82,  name:'三合一磁怪',   type:'electric', type2:'steel',   hp:210, tier:1, ability:{id:'item-synergy', name:'機械之心', trigger:'onAttack', desc:'本回合使用過道具卡時，攻擊傷害 +40，並且下回合對手造成的傷害-50'}, attacks:[{name:'衝浪',dmg:54,cost:2,type:'water',ignoreReflect:true,status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'sleep',chance:0.4}},{name:'劇毒威壓擊',dmg:50,cost:2,type:'poison',rider:'mega-charge'},{name:'金屬音',dmg:74,cost:6,type:'steel',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'電磁炮',dmg:105,cost:8,type:'electric',selfHeal:0.18,bonusVsType:'ground',ignoreReflect:true}]},
  { id:28,  name:'穿山王',     type:'ground',   hp:240, tier:1, ability:{id:'ground-domain', name:'風沙支配', trigger:'onEnter', desc:'上場時場地切換為沙塵暴；地面屬性攻擊傷害額外 +40'}, attacks:[{name:'精神吸能擊',dmg:41,cost:1,type:'psychic',rider:'energy-steal'},{name:'水之脈動',dmg:76,cost:5,type:'water',megaBoost:true,bonusEnergy:4,rider:'mega-charge'},{name:'岩石碎裂',dmg:72,cost:5,type:'rock',megaBoost:true,bonusEnergy:4},{name:'地震',dmg:91,cost:7,type:'ground',status:{effect:'sleep', chance:0.4},bonusVsType:'ground',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10071, type:'water', type2:'psychic', ability:{id:'sturdy-half', name:'硬殼盔甲', trigger:'onDefend', desc:'HP >50% 時，受到會直接擊倒的攻擊會保留 1 HP'}}, id:80,  name:'呆殼獸',     type:'water',    type2:'psychic', hp:260, tier:1, ability:{id:'own-tempo', name:'我行我素', trigger:'onDefend', desc:'不會陷入負面狀態'}, attacks:[{name:'連續切',dmg:50,cost:2,type:'bug',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'精神強擊',dmg:70,cost:5,type:'psychic',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:5,rider:'move-reflect'},{name:'灼熱護甲擊',dmg:77,cost:5,type:'fire',rider:'mega-charge'},{name:'衝浪',dmg:96,cost:7,type:'water',ignoreReflect:true,status:{effect:'confusion', chance:0.4},bonusVsType:'psychic'}]},
  /* ── Tier 1 新 ── */
  { id:823, name:'鋼鎧鴉',     type:'steel',    type2:'flying',  hp:250, tier:1, ability:{id:'pressure-drain', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 5點能量，對手每回合回復的能量-3（僅限這隻寶可夢在場上時持續）'}, attacks:[{name:'念力衝擊',dmg:51,cost:2,type:'psychic',rider:'energy-steal',megaBoost:true,bonusEnergy:5},{name:'空氣斬',dmg:71,cost:5,type:'flying',megaBoost:true,bonusEnergy:5},{name:'激流強奪擊',dmg:78,cost:5,type:'water',rider:'card-steal'},{name:'鐵翼',dmg:97,cost:7,type:'steel',selfHeal:0.28,bonusVsType:'fighting',ignoreReflect:true,ignoreShield:true}]},

  { mega:{spriteId:10283, type:'water', type2:'dragon', ability:{id:'dragonize', name:'龍化', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2，並且攻擊附帶龍屬性傷害(計算傷害時，招式屬性以及龍屬性攻擊擇優進行計算）'}}, id:160, name:'大力鱷',     type:'water',    hp:260, tier:1, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'灼熱吸血擊',dmg:45,cost:2,type:'fire',rider:'self-cure',bonusVsType:'bug'},{name:'冰凍拳',dmg:80,cost:6,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6,rider:'card-steal'},{name:'電擊',dmg:76,cost:6,type:'electric',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'衝浪',dmg:96,cost:8,type:'water',status:{effect:'paralysis', chance:0.4},bonusVsType:'water'}]},
  { mega:{spriteId:10294, type:'water', type2:'dark', ability:{id:'protean-max', name:'變幻自如', trigger:'onAttack', desc:'攻擊一律視為克制對手的屬性'}}, id:658, name:'甲賀忍蛙',       type:'water',    type2:'dark',    hp:220, tier:1, ability:{id:'rough-skin', name:'粗糙皮膚', trigger:'onDefend', desc:'受到攻擊傷害時，反彈攻擊者 1/8 最大HP 傷害'}, attacks:[{name:'影子偷襲',dmg:56,cost:2,type:'ghost',rider:'energy-steal',megaBoost:true,bonusEnergy:6,bonusVsType:'ground'},{name:'夜斬',dmg:80,cost:6,type:'dark',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'水手裏劍',dmg:110,cost:8,type:'water',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'荒草威壓擊',dmg:55,cost:2,type:'grass',rider:'mega-charge'}]},
  /* ── Tier 2 中 ── */
  { mega:{spriteId:10034, type:'fire', type2:'dragon', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:6,   name:'噴火龍',     type:'fire',     type2:'flying',  hp:290, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'雷光強奪擊',dmg:69,cost:5,type:'electric',rider:'type-draw',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'龍爪',dmg:48,cost:1,type:'dragon',rider:'energy-steal',megaBoost:true,bonusEnergy:5},{name:'火焰噴射',dmg:95,cost:7,type:'fire',status:{effect:'paralysis', chance:0.4},bonusVsType:'flying'},{name:'燕返',dmg:91,cost:7,type:'flying',status:{effect:'freeze', chance:0.4},bonusVsType:'bug',ignoreReflect:true}]},
  { mega:{spriteId:10036, type:'water', type2:null, ability:{id:'mega-launcher', name:'超級發射器', trigger:'onCard', desc:'使用卡牌時，會對對手寶可夢造成50傷害'}}, id:9,   name:'水箭龜',     type:'water',    hp:280, tier:2, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'妖精吸血擊',dmg:42,cost:0,type:'fairy',rider:'mega-charge',megaBoost:true,bonusEnergy:4},{name:'蟲毒吸能擊',dmg:66,cost:5,type:'bug',rider:'type-draw'},{name:'水砲',dmg:96,cost:7,type:'water',selfHeal:0.28,bonusVsType:'dark'},{name:'冰凍光束',dmg:92,cost:7,type:'ice',selfHeal:0.29,bonusVsType:'dragon',ignoreReflect:true}]},
  { mega:{spriteId:10043, type:'psychic', type2:'fighting', ability:{id:'guts-half-survive', name:'不屈之心', trigger:'onAttack', desc:'受到致命傷害時，有50%機率以10%HP存活，攻擊不會被對手減傷'}}, id:150, name:'超夢',       type:'psychic',  hp:320, tier:2, ability:{id:'pressure-drain', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 5點能量，對手每回合回復的能量-3（僅限這隻寶可夢在場上時持續）'}, attacks:[{name:'氣功拳',dmg:89,cost:7,type:'fighting',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:4},{name:'念力衝擊',dmg:96,cost:7,type:'psychic',selfHeal:0.19,bonusVsType:'rock'},{name:'閃電拳',dmg:92,cost:7,type:'electric',status:{effect:'sleep', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'暗影球',dmg:65,cost:5,type:'ghost',rider:'type-draw',status:{effect:'poison', chance:0.4},status2:{effect:'burn',chance:0.4}}]},
  { mega:{spriteId:10281, type:'dragon', type2:'flying', ability:{id:'multiscale', name:'多重鱗片', trigger:'onDefend', desc:'HP 全滿時，受到的攻擊傷害 ×0.1'}}, id:149, name:'快龍',       type:'dragon',   type2:'flying',  hp:320, tier:2, ability:{id:'multiscale', name:'多重鱗片', trigger:'onDefend', desc:'HP 全滿時，受到的攻擊傷害 ×0.1'}, attacks:[{name:'雷電',dmg:87,cost:7,type:'electric',megaBoost:true,bonusEnergy:4},{name:'逆鱗護甲擊',dmg:94,cost:7,type:'dragon',status:{effect:'paralysis', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'暴風護甲擊',dmg:67,cost:5,type:'flying',rider:'energy-steal'},{name:'破壞光線',dmg:86,cost:7,type:'normal',status:{effect:'paralysis', chance:0.4},ignoreReflect:true,ignoreShield:true}]},
  { id:143, name:'卡比獸',     type:'normal',   hp:380, tier:2, ability:{id:'normal-domain', name:'神域支配', trigger:'onEnter', desc:'上場時場地切換為莊嚴神社；一般屬性攻擊傷害額外 +40'}, attacks:[{name:'磚塊',dmg:105,cost:8,type:'rock',megaBoost:true,bonusEnergy:8},{name:'鐵頭',dmg:89,cost:7,type:'steel',rider:'self-cure',selfHeal:0.25},{name:'地震',dmg:108,cost:8,type:'ground',status:{effect:'freeze', chance:0.4},bonusVsType:'poison'},{name:'喊叫',dmg:110,cost:8,type:'normal',selfHeal:0.29,bonusVsType:'rock',ignoreReflect:true,ignoreShield:true}]},
  { id:59,  name:'風速狗',     type:'fire',     hp:260, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}, attacks:[{name:'連續啃咬',dmg:52,cost:2,type:'dark',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'冰霜強奪擊',dmg:76,cost:6,type:'ice',rider:'type-draw'},{name:'頭槌',dmg:72,cost:6,type:'normal',megaBoost:true,bonusEnergy:5},{name:'噴射火焰',dmg:103,cost:8,type:'fire',ignoreReflect:true,status:{effect:'burn', chance:0.4},bonusVsType:'ice',ignoreShield:true}]},
  { id:131, name:'拉普拉斯',   type:'water',    type2:'ice',     hp:290, tier:2, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'遠古之力',dmg:49,cost:1,type:'rock',rider:'type-draw',megaBoost:true,bonusEnergy:5},{name:'冷凍光線',dmg:73,cost:5,type:'ice',rider:'energy-steal',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'雷電',dmg:92,cost:7,type:'electric',selfHeal:0.21,bonusVsType:'water'},{name:'衝浪',dmg:99,cost:7,type:'water',selfHeal:0.17,bonusVsType:'flying',ignoreReflect:true}]},
  { mega:{spriteId:10058, type:'dragon', type2:'ground', ability:{id:'sandstorm-stadium-dodge', name:'揚沙', trigger:'onEnter', desc:'上場時場地切換為沙塵暴，並且有20%機率完全閃避攻擊'}}, id:445, name:'烈咬陸鯊',   type:'dragon',   type2:'ground',  hp:280, tier:2, ability:{id:'sandstorm-stadium-dodge', name:'揚沙', trigger:'onEnter', desc:'上場時場地切換為沙塵暴，並且有20%機率完全閃避攻擊'}, attacks:[{name:'惡意突刺',dmg:50,cost:1,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'疾風吸血擊',dmg:74,cost:5,type:'flying',rider:'life-drain'},{name:'地震',dmg:93,cost:7,type:'ground',selfHeal:0.23,bonusVsType:'fire'},{name:'龍爪',dmg:100,cost:7,type:'dragon',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true}]},
  { id:210, name:'布魯皇',     type:'fairy',    hp:300, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}, attacks:[{name:'咬碎',dmg:70,cost:5,type:'dark',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'雷電',dmg:53,cost:2,type:'electric',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'poison',chance:0.4}},{name:'妖精之力',dmg:96,cost:7,type:'fairy',status:{effect:'sleep', chance:0.4},bonusVsType:'ghost',ignoreReflect:true},{name:'地震',dmg:92,cost:7,type:'ground',status:{effect:'confusion', chance:0.4},bonusVsType:'steel'}]},
  { id:700, name:'仙子伊布',   type:'fairy',    hp:300, tier:2, ability:{id:'fairy-domain', name:'妖精支配', trigger:'onEnter', desc:'上場時場地切換為妖精結界原野；妖精屬性攻擊傷害額外 +40'}, attacks:[{name:'毒牙',dmg:52,cost:2,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'冰凍光束',dmg:82,cost:6,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'poison',chance:0.4}},{name:'妖精風',dmg:102,cost:8,type:'fairy',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true},{name:'暗影球',dmg:98,cost:8,type:'ghost',status:{effect:'freeze', chance:0.4},bonusVsType:'psychic'}]},
  { mega:{spriteId:10285, type:'ice', type2:'ghost', ability:{id:'snowfall', name:'降雪', trigger:'onEnter', desc:'上場時，將場地切換為永凍冰原，並且每回合給予對手寶可夢50HP 傷害'}}, id:478, name:'雪妖女',     type:'ice',      type2:'ghost',   hp:280, tier:2, ability:{id:'snowfall', name:'降雪', trigger:'onEnter', desc:'上場時，將場地切換為永凍冰原，並且每回合給予對手寶可夢50HP 傷害'}, attacks:[{name:'怒風',dmg:50,cost:1,type:'flying',rider:'energy-steal',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:4,status2:{effect:'sleep',chance:0.4}},{name:'冰凍光束',dmg:97,cost:7,type:'ice',megaBoost:true,bonusEnergy:4},{name:'幽靈球',dmg:93,cost:7,type:'ghost',ignoreReflect:true,status:{effect:'sleep', chance:0.4},bonusVsType:'ghost'},{name:'激流威壓擊',dmg:77,cost:5,type:'water',rider:'mega-charge'}]},
  { id:614, name:'凍原熊',     type:'ice',      hp:215, tier:2, ability:{id:'ice-domain', name:'冰霜支配', trigger:'onEnter', desc:'上場時場地切換為永凍冰原；冰屬性攻擊傷害額外 +40'}, attacks:[{name:'地震',dmg:51,cost:2,type:'ground',rider:'mega-charge',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'confusion',chance:0.4}},{name:'大浪',dmg:75,cost:6,type:'water',status:{effect:'poison', chance:0.4},bonusVsType:'rock',ignoreReflect:true},{name:'火焰噴射',dmg:54,cost:2,type:'fire',status:{effect:'burn', chance:0.4}},{name:'冰耳光',dmg:102,cost:8,type:'ice',status:{effect:'poison', chance:0.4},bonusVsType:'poison'}]},
  { id:430, name:'烏鴉頭頭',     type:'dark',     type2:'flying',  hp:300, tier:2, ability:{id:'insomnia', name:'不眠', trigger:'onAttack', desc:'不會陷入睡眠狀態，每回合30%機率額外抽一張道具卡'}, attacks:[{name:'超能力',dmg:51,cost:2,type:'psychic',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'暴風',dmg:86,cost:6,type:'flying',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'夜斬',dmg:105,cost:8,type:'dark',selfHeal:0.22,bonusVsType:'fighting',ignoreReflect:true},{name:'毒粉刺',dmg:101,cost:8,type:'poison',status:{effect:'poison', chance:0.4},bonusVsType:'grass'}]},
  { id:466, name:'電擊魔獸',   type:'electric', hp:300, tier:2, ability:{id:'electric-domain', name:'雷霆支配', trigger:'onEnter', desc:'上場時場地切換為雷雲庇護所；電屬性攻擊傷害額外 +40'}, attacks:[{name:'冰凍拳',dmg:85,cost:6,type:'ice',rider:'type-draw',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'決勝衝擊',dmg:53,cost:2,type:'fighting',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'超能力',dmg:100,cost:8,type:'psychic',selfHeal:0.18,bonusVsType:'fighting'},{name:'電磁衝浪',dmg:107,cost:8,type:'electric',status:{effect:'poison', chance:0.4},bonusVsType:'ground',ignoreReflect:true}]},
  { id:467, name:'鴨嘴炎獸',   type:'fire',     hp:300, tier:2, ability:{id:'flame-body', name:'火焰之軀', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入燒傷，並且將場地切換為熔岩火山'}, attacks:[{name:'惡意突刺',dmg:82,cost:6,type:'poison',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'sleep',chance:0.4}},{name:'地震',dmg:55,cost:2,type:'ground',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'閃電拳',dmg:98,cost:8,type:'electric',status:{effect:'paralysis', chance:0.4},bonusVsType:'water',ignoreReflect:true},{name:'火焰衝擊',dmg:105,cost:8,type:'fire',status:{effect:'poison', chance:0.4},bonusVsType:'fairy'}]},
  /* ── Tier 2 新 ── */
  { id:157, name:'火爆獸',     type:'fire',                      hp:260, tier:2, ability:{id:'drought-lava', name:'熔岩大地', trigger:'onEnter', desc:'上場時場地切換為熔岩火山；地面／火屬性攻擊傷害額外 +40'}, attacks:[{name:'疾風吸能擊',dmg:78,cost:6,type:'flying',ignoreReflect:true,rider:'energy-steal'},{name:'地震',dmg:74,cost:6,type:'ground',megaBoost:true,bonusEnergy:7,rider:'self-cure'},{name:'毒粉刺',dmg:58,cost:2,type:'poison',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'爆炸火焰',dmg:101,cost:8,type:'fire',status:{effect:'poison', chance:0.4},bonusVsType:'fairy'}]},
  { mega:{spriteId:10282, type:'grass', type2:'fairy', ability:{id:'solar-core', name:'太陽核心', trigger:'onAttack', desc:'攻擊完後，將招式屬性變為火屬性，並將傷害x0.2 再攻擊一次'}}, id:154, name:'大竺葵',     type:'grass',                     hp:270, tier:2, ability:{id:'blaze-boost-pure', name:'茂盛', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，並且HP 低於 1/3 時，招式傷害額外 ×1.1'}, attacks:[{name:'逆鱗護甲擊',dmg:58,cost:4,type:'dragon',rider:'mega-charge',bonusVsType:'dragon'},{name:'大地之力',dmg:89,cost:7,type:'ground',megaBoost:true,bonusEnergy:8,rider:'mega-charge'},{name:'閃電拳',dmg:85,cost:7,type:'electric',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'花瓣風暴',dmg:110,cost:8,type:'grass',status:{effect:'paralysis', chance:0.4},bonusVsType:'water'}]},
  /* ── Tier 3 強 ── */
  { id:383, name:'固拉多',     type:'ground',   hp:300, tier:3, ability:{id:'drought-lava', name:'熔岩大地', trigger:'onEnter', desc:'上場時場地切換為熔岩火山；地面／火屬性攻擊傷害額外 +40'}, attacks:[{name:'地震',dmg:103,cost:8,type:'ground',megaBoost:true,bonusEnergy:6,bonusVsType:'fire',ignoreReflect:true},{name:'岩石碎裂',dmg:52,cost:2,type:'rock',selfHeal:0.22},{name:'火焰噴射',dmg:82,cost:6,type:'fire',ignoreReflect:true,status:{effect:'confusion', chance:0.4},status2:{effect:'sleep',chance:0.4}},{name:'妖精威壓擊',dmg:102,cost:8,type:'fairy',rider:'move-reflect',status:{effect:'burn', chance:0.4},selfHeal:0.26}]},
  { id:382, name:'蓋歐卡',     type:'water',    hp:290, tier:3, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'橫衝直撞',dmg:77,cost:6,type:'normal',rider:'energy-steal',megaBoost:true,bonusEnergy:5,ignoreReflect:true},{name:'雷電',dmg:97,cost:8,type:'electric',status:{effect:'burn', chance:0.4},bonusVsType:'water'},{name:'源起之波',dmg:104,cost:8,type:'water',selfHeal:0.16,ignoreReflect:true},{name:'原始海洋',dmg:48,cost:2,type:'ice',rider:'type-draw',selfHeal:0.21}]},
  { mega:{spriteId:10079, type:'dragon', type2:'flying', ability:{id:'delta-stream', name:'德爾塔氣流', trigger:'onEnter', desc:'將場地切換為疾風之翼，並且這隻寶可夢在場期間，場地無法被覆蓋（只能被清除）'}}, id:384, name:'烈空坐',     type:'dragon',   type2:'flying',  hp:320, tier:3, ability:{id:'weaken-buffs', name:'威壓氣場', trigger:'onEnter', desc:'上場時讓對手能量歸零，並讓對方下一次攻擊傷害 -50'}, attacks:[{name:'燕返',dmg:95,cost:7,type:'flying',rider:'self-cure',megaBoost:true,bonusEnergy:7},{name:'火焰噴射',dmg:91,cost:7,type:'fire',status:{effect:'freeze', chance:0.4},bonusVsType:'steel'},{name:'神速',dmg:87,cost:7,type:'normal',status:{effect:'poison', chance:0.4},bonusVsType:'bug'},{name:'龍之隕星',dmg:71,cost:5,type:'dragon',rider:'self-cure',status:{effect:'burn', chance:0.4},status2:{effect:'confusion',chance:0.4}}]},
  { id:1008,name:'密勒頓',     type:'electric', type2:'dragon',  hp:360, tier:3, ability:{id:'hadron-engine', name:'強子引擎', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1；每回合開始必定額外抽到一張電光石火'}, attacks:[{name:'電磁衝浪',dmg:99,cost:8,type:'electric',ignoreReflect:true,status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:7,bonusVsType:'flying'},{name:'逆鱗護甲擊',dmg:106,cost:8,type:'dragon',selfHeal:0.17},{name:'毒牙',dmg:102,cost:8,type:'poison',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true},{name:'精神強擊',dmg:74,cost:6,type:'psychic',rider:'mega-charge',selfHeal:0.23}]},
  { id:250, name:'鳳王',       type:'fire',     type2:'flying',  hp:260, tier:3, ability:{id:'healing-rainbow', name:'治癒彩虹', trigger:'onDefend', desc:'被擊倒後可以復活一次，HP 回復 50%（整場戰鬥限一次）；不會受到任何負面狀態'}, attacks:[{name:'妖精威壓擊',dmg:54,cost:2,type:'fairy',rider:'self-cure',status:{effect:'paralysis', chance:0.4}},{name:'聖焰',dmg:73,cost:6,type:'fire',ignoreReflect:true,status:{effect:'burn', chance:1},status2:{effect:'poison',chance:1}},{name:'大地波動',dmg:80,cost:6,type:'ground',rider:'energy-steal'},{name:'怒風',dmg:100,cost:8,type:'flying',selfHeal:0.22,bonusVsType:'dragon'}]},
  { id:249, name:'洛奇亞',     type:'psychic',  type2:'flying',  hp:255, tier:3, ability:{id:'vortex-pressure', name:'漩渦威壓', trigger:'onDefend', desc:'牠在場上時，對手攻擊消耗的能量持續 +3；每回合開始 50% 機率抽到一張大海之盾'}, attacks:[{name:'幽靈球',dmg:43,cost:1,type:'ghost',rider:'mega-charge',status:{effect:'confusion', chance:0.4}},{name:'暴風',dmg:78,cost:5,type:'flying',rider:'type-draw',status:{effect:'sleep', chance:0.4}},{name:'冰凍光束',dmg:74,cost:5,type:'ice',rider:'guard-up'},{name:'未來雷霆',dmg:93,cost:7,type:'psychic',ignoreReflect:true,status:{effect:'freeze', chance:0.4},bonusVsType:'ghost'}]},
  { id:1007,name:'故勒頓',     type:'fighting', type2:'dragon',  hp:360, tier:3, ability:{id:'crimson-pulse', name:'緋紅脈動', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1；每回合開始必定額外抽到一張直搗黃龍'}, attacks:[{name:'火焰噴射',dmg:101,cost:8,type:'fire',megaBoost:true,bonusEnergy:7,bonusVsType:'steel',ignoreReflect:true},{name:'決勝衝擊',dmg:108,cost:8,type:'fighting',status:{effect:'burn', chance:0.4},bonusVsType:'bug'},{name:'泥巴射擊',dmg:104,cost:8,type:'ground',status:{effect:'sleep', chance:0.4},bonusVsType:'electric'},{name:'遠古之力',dmg:77,cost:6,type:'rock',rider:'energy-steal',selfHeal:0.3}]},
  { mega:{spriteId:10051, type:'psychic', type2:'fairy', ability:{id:'fairy-skin', name:'妖精皮膚', trigger:'onAttack', desc:'攻擊附帶妖精屬性傷害(計算傷害時，招式屬性以及妖精屬性攻擊擇優進行計算），受到攻擊時，賦予對手混亂'}}, id:282, name:'沙奈朵',     type:'psychic',  type2:'fairy',   hp:205, tier:3, ability:{id:'sync-status', name:'同步', trigger:'onDefend', desc:'被賦予負面狀態時，也給予對手相同的負面狀態'}, attacks:[{name:'毒針',dmg:43,cost:1,type:'poison',megaBoost:true,bonusEnergy:4},{name:'暗影球',dmg:78,cost:5,type:'ghost',selfHeal:0.26,bonusVsType:'psychic'},{name:'妖精之力',dmg:97,cost:7,type:'fairy',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true,ignoreShield:true},{name:'精神強擊',dmg:42,cost:1,type:'psychic',rider:'energy-steal',selfHeal:0.24}]},
  { id:144, name:'急凍鳥',     type:'ice',      type2:'flying',  hp:340, tier:3, ability:{id:'pressure-drain', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 5點能量，對手每回合回復的能量-3（僅限這隻寶可夢在場上時持續）'}, attacks:[{name:'暴風雪',dmg:74,cost:6,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'燕返',dmg:105,cost:8,type:'flying',ignoreReflect:true,status:{effect:'sleep', chance:0.4},bonusVsType:'bug'},{name:'幽冥威壓擊',dmg:101,cost:8,type:'ghost',selfHeal:0.22,bonusVsType:'ghost',ignoreReflect:true,ignoreShield:true},{name:'橫衝直撞',dmg:97,cost:8,type:'normal',selfHeal:0.25}]},
  { id:145, name:'閃電鳥',     type:'electric', type2:'flying',  hp:245, tier:3, ability:{id:'pressure-drain', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 5點能量，對手每回合回復的能量-3（僅限這隻寶可夢在場上時持續）'}, attacks:[{name:'龍爪',dmg:72,cost:5,type:'dragon',rider:'type-draw',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'猛禽炸彈',dmg:68,cost:5,type:'flying',status:{effect:'sleep', chance:0.4},bonusVsType:'fighting'},{name:'雷霆',dmg:98,cost:7,type:'electric',selfHeal:0.25,bonusVsType:'dragon'},{name:'吼叫',dmg:43,cost:1,type:'normal',rider:'type-draw',status:{effect:'paralysis', chance:0.4},status2:{effect:'poison',chance:0.4}}]},
  { id:146, name:'火焰鳥',     type:'fire',     type2:'flying',  hp:200, tier:3, ability:{id:'pressure-drain', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 5點能量，對手每回合回復的能量-3（僅限這隻寶可夢在場上時持續）'}, attacks:[{name:'火焰衝擊',dmg:92,cost:7,type:'fire',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6,bonusVsType:'ice',ignoreReflect:true},{name:'超能力',dmg:40,cost:0,type:'psychic',rider:'energy-steal',status:{effect:'confusion', chance:0.4},selfHeal:0.16,status2:{effect:'burn',chance:0.4}},{name:'十萬伏特',dmg:72,cost:5,type:'electric',status:{effect:'paralysis', chance:0.4}},{name:'怒風',dmg:40,cost:0,type:'flying',ignoreReflect:true,selfHeal:0.28}]},
  { mega:{spriteId:10188, type:'fairy', type2:'steel', ability:{id:'crowned-sword-might', name:'劍之王氣魄', trigger:'onAttack', desc:'攻擊傷害固定 +30，且無視對方護盾'}}, id:888,name:'蒼響',      type:'fairy',    type2:'steel',   hp:320, tier:3, ability:{id:'steel-domain', name:'鋼鐵支配', trigger:'onEnter', desc:'上場時場地切換為鋼鐵堡壘；鋼屬性攻擊傷害額外 +40'}, attacks:[{name:'接近戰',dmg:105,cost:8,type:'fighting',megaBoost:true,bonusEnergy:8},{name:'月亮力量',dmg:101,cost:8,type:'fairy',ignoreReflect:true,selfHeal:0.19,bonusVsType:'dark'},{name:'鐵頭功',dmg:108,cost:8,type:'steel',selfHeal:0.21,bonusVsType:'normal',ignoreReflect:true,ignoreShield:true},{name:'劇毒威壓擊',dmg:81,cost:6,type:'poison',selfHeal:0.18}]},
  { mega:{spriteId:10189, type:'fighting', type2:'steel', ability:{id:'crowned-shield-aegis', name:'盾之王神威', trigger:'onDefend', desc:'受到的攻擊傷害固定 -30，且免疫所有異常狀態'}}, id:889,name:'藏瑪然特',    type:'fighting', type2:null,      hp:320, tier:3, ability:{id:'steel-domain', name:'鋼鐵支配', trigger:'onEnter', desc:'上場時場地切換為鋼鐵堡壘；鋼屬性攻擊傷害額外 +40'}, attacks:[{name:'大顎噬咬',dmg:105,cost:8,type:'steel',bonusVsType:'fairy',ignoreReflect:true},{name:'接近戰',dmg:108,cost:8,type:'fighting',selfHeal:0.2},{name:'咬碎',dmg:101,cost:8,type:'dark',status:{effect:'confusion', chance:0.35},ignoreShield:true},{name:'地震',dmg:82,cost:6,type:'ground',selfHeal:0.18,bonusVsType:'steel'}]},
  { id:716, name:'哲爾尼亞斯', type:'fairy',    hp:305, tier:3, ability:{id:'fairy-aura-field', name:'妖精氣場', trigger:'onEnter', desc:'上場時場地切換為妖精結界原野，並回復8點能量'}, attacks:[{name:'飛葉快刀',dmg:56,cost:3,type:'grass',rider:'type-draw'},{name:'十萬伏特',dmg:91,cost:7,type:'electric',status:{effect:'paralysis', chance:0.4},status2:{effect:'burn',chance:0.4}},{name:'魔法閃耀',dmg:110,cost:8,type:'fairy',rider:'card-steal'},{name:'冰耳光',dmg:106,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'flying',ignoreReflect:true}]},
  { id:378, name:'雷吉艾斯',   type:'ice',      hp:370, tier:3, ability:{id:'thick-fat-pure', name:'厚脂肪', trigger:'onDefend', desc:'受到的傷害-50，HP 低於 1/3 時，招式傷害額外 ×1.2'}, attacks:[{name:'暴風雪',dmg:108,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:8,bonusVsType:'grass'},{name:'閃光炮',dmg:81,cost:6,type:'steel',rider:'self-cure',status:{effect:'paralysis', chance:0.4}},{name:'未來雷霆',dmg:100,cost:8,type:'psychic',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting'},{name:'電磁砲',dmg:107,cost:8,type:'electric',rider:'mega-charge',status:{effect:'burn', chance:0.4},status2:{effect:'freeze',chance:0.4}}]},
  /* ── Tier 3 新 ── */
  { id:717, name:'伊裴爾塔爾', type:'dark',     type2:'flying',  hp:265, tier:3, ability:{id:'dark-abyss-lockdown', name:'深淵支配', trigger:'passive', desc:'對方無法使用 Mega 進化；這隻寶可夢在場上時，對方的寶可夢無法回復 HP'}, attacks:[{name:'幽靈球',dmg:53,cost:2,type:'ghost',ignoreReflect:true},{name:'空氣斬',dmg:77,cost:6,type:'flying',rider:'mega-charge',status:{effect:'freeze', chance:0.4},status2:{effect:'paralysis',chance:0.4}},{name:'大地虹吸',dmg:84,cost:6,type:'ground',rider:'life-drain'},{name:'惡意波動',dmg:103,cost:8,type:'dark',selfHeal:0.25,bonusVsType:'ghost'}]},
  { id:483, name:'帝牙盧卡',   type:'steel',    type2:'dragon',  hp:360, tier:3, ability:{id:'time-roar', name:'時間咆哮', trigger:'onAttack', desc:'回合開始時，獲得對手上回合使用過的隨機一半道具卡。並且遊戲中有一次機會100%迴避致命傷害（當受到的傷害超過當前的HP時，100%迴避）'}, attacks:[{name:'閃光炮',dmg:105,cost:8,type:'steel',ignoreReflect:true,megaBoost:true,bonusEnergy:7,bonusVsType:'fairy',ignoreShield:true},{name:'龍之脈動',dmg:101,cost:8,type:'dragon',selfHeal:0.19,bonusVsType:'dragon'},{name:'雷霆',dmg:73,cost:6,type:'electric',rider:'mega-charge',selfHeal:0.21},{name:'幽靈之爪',dmg:104,cost:8,type:'ghost',selfHeal:0.2}]},
  { id:484, name:'帕路奇亞',   type:'water',    type2:'dragon',  hp:200, tier:3, ability:{id:'space-cut', name:'空間切割', trigger:'passive', desc:'對手不能發動競技場（包含對手特性也不行，僅限這隻寶可夢在場上時持續）。上場時，清除當前的競技場效果'}, attacks:[{name:'鐵翼',dmg:40,cost:1,type:'steel',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'龍之脈動',dmg:47,cost:1,type:'dragon',status:{effect:'paralysis', chance:0.4}},{name:'空間扭曲',dmg:71,cost:5,type:'psychic',ignoreReflect:true,selfHeal:0.25,bonusVsType:'fighting',ignoreShield:true},{name:'衝浪',dmg:101,cost:7,type:'water',selfHeal:0.15,bonusVsType:'ice'}]},
  { id:487, name:'騎拉帝納',   type:'ghost',    type2:'dragon',  hp:350, tier:3, ability:{id:'reverse-world-dodge', name:'反轉世界', trigger:'onEnter', desc:'上場時場地切換為反轉世界，並且有10%機率完全閃避攻擊'}, attacks:[{name:'影子偷襲',dmg:43,cost:1,type:'ghost',rider:'energy-steal'},{name:'龍息',dmg:65,cost:3,type:'dragon',megaBoost:true,bonusEnergy:5,status:{effect:'confusion', chance:0.4}},{name:'影子球',dmg:92,cost:6,type:'ghost',selfHeal:0.2,bonusVsType:'psychic'},{name:'暗影猛擊',dmg:110,cost:8,type:'ghost',ignoreReflect:true,ignoreShield:true,bonusVsType:'fighting'}]},
  { id:727, name:'熾焰咆哮虎', type:'fire',     type2:'dark',    hp:300, tier:2, ability:{id:'dark-domain', name:'暗夜支配', trigger:'onEnter', desc:'上場時場地切換為暗夜詛咒領域；惡屬性攻擊傷害額外 +40'}, attacks:[{name:'超強衝擊',dmg:56,cost:3,type:'fighting',ignoreReflect:true,status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'sleep',chance:0.4}},{name:'暗黑強打',dmg:86,cost:6,type:'dark',megaBoost:true,bonusEnergy:7},{name:'火焰噴射',dmg:105,cost:8,type:'fire',status:{effect:'paralysis', chance:0.4},bonusVsType:'dark',ignoreReflect:true},{name:'劇毒威壓擊',dmg:101,cost:8,type:'poison',selfHeal:0.2,bonusVsType:'fairy'}]},
  /* ── 新增：補足各屬性 ── */
  /* 一般 */
  { id:128, name:'肯泰羅',       type:'normal',                    hp:240, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}, attacks:[{name:'夜襲',dmg:40,cost:0,type:'dark',rider:'energy-steal',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'灼熱吸血擊',dmg:73,cost:5,type:'fire',ignoreReflect:true,rider:'life-drain'},{name:'地震',dmg:69,cost:5,type:'ground',megaBoost:true,bonusEnergy:5},{name:'橫衝直撞',dmg:88,cost:7,type:'normal',selfHeal:0.21,bonusVsType:'psychic',ignoreReflect:true}]},
  { id:295, name:'爆音怪',       type:'normal',                    hp:240, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'受到致命傷害時，有30%機率以1HP存活'}, attacks:[{name:'疾風威壓擊',dmg:47,cost:1,type:'flying',rider:'self-cure'},{name:'大字爆炎',dmg:71,cost:5,type:'fire',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:4,rider:'card-steal'},{name:'衝浪',dmg:78,cost:5,type:'water',megaBoost:true,bonusEnergy:4,rider:'self-cure'},{name:'破壞光線',dmg:97,cost:7,type:'normal',status:{effect:'paralysis', chance:0.4},ignoreReflect:true,ignoreShield:true}]},
  /* 草 */
  { mega:{spriteId:10065, type:'grass', type2:'dragon', ability:{id:'motor-drive', name:'避雷針', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:254, name:'蜥蜴王',       type:'grass',                     hp:260, tier:2, ability:{id:'blaze-boost-pure', name:'茂盛', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，並且HP 低於 1/3 時，招式傷害額外 ×1.1'}, attacks:[{name:'閃電拳',dmg:46,cost:2,type:'electric',rider:'mega-charge',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'confusion',chance:0.4}},{name:'能量球',dmg:105,cost:8,type:'grass',ignoreReflect:true,status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'大地之力',dmg:77,cost:6,type:'ground',megaBoost:true,bonusEnergy:5,rider:'move-reflect'},{name:'神速吸能擊',dmg:73,cost:6,type:'normal',rider:'self-cure'}]},
  /* 毒 */
  { id:24,  name:'阿柏怪',       type:'poison',                    hp:200, tier:1, ability:{id:'poison-domain', name:'劇毒支配', trigger:'onEnter', desc:'上場時場地切換為劇毒領域；毒屬性攻擊傷害額外 +40'}, attacks:[{name:'纏繞',dmg:40,cost:0,type:'normal',rider:'mega-charge',status:{effect:'sleep', chance:0.4},megaBoost:true,bonusEnergy:4},{name:'地震',dmg:40,cost:0,type:'ground',rider:'type-draw',status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:4,status2:{effect:'confusion',chance:0.4}},{name:'毒牙',dmg:93,cost:7,type:'poison',megaBoost:true,bonusEnergy:4},{name:'鋼影護甲擊',dmg:66,cost:5,type:'steel',ignoreReflect:true,rider:'guard-up'}]},
  { id:73,  name:'毒刺水母',     type:'water',    type2:'poison',  hp:220, tier:1, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'蟲毒強奪擊',dmg:52,cost:2,type:'bug',rider:'energy-steal'},{name:'火花',dmg:59,cost:2,type:'fire',rider:'self-cure',status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'freeze',chance:0.4}},{name:'衝浪',dmg:83,cost:6,type:'water',megaBoost:true,bonusEnergy:7},{name:'毒液',dmg:102,cost:8,type:'poison',status:{effect:'burn', chance:0.4},bonusVsType:'bug',ignoreReflect:true}]},
  { id:454, name:'毒骷蛙',       type:'fighting', type2:'poison',  hp:230, tier:1, ability:{id:'water-absorb', name:'乾燥皮膚', trigger:'onDefend', desc:'受到水屬性攻擊時完全免疫，並回復最大HP的1/4'}, attacks:[{name:'妖精吸血擊',dmg:64,cost:4,type:'fairy',rider:'mega-charge',bonusVsType:'dragon'},{name:'夜襲',dmg:60,cost:4,type:'dark',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'十字劈',dmg:91,cost:7,type:'fighting',megaBoost:true,bonusEnergy:7,rider:'mega-charge'},{name:'劇毒威壓擊',dmg:110,cost:8,type:'poison',selfHeal:0.27,bonusVsType:'grass'}]},
  /* 地面 */
  { id:553, name:'流氓鱷',       type:'ground',   type2:'dark',    hp:270, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}, attacks:[{name:'岩石滑落',dmg:88,cost:7,type:'rock',rider:'energy-steal',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'freeze',chance:0.4}},{name:'激流威壓擊',dmg:60,cost:4,type:'water',rider:'self-cure'},{name:'地震',dmg:91,cost:7,type:'ground',megaBoost:true,bonusEnergy:7},{name:'暗黑強打',dmg:110,cost:8,type:'dark',ignoreReflect:true,selfHeal:0.24,bonusVsType:'ghost'}]},
  /* 飛行 */
  { id:641, name:'龍捲雲',       type:'flying',                    hp:290, tier:2, ability:{id:'mischief-heart', name:'惡作劇之心', trigger:'onEnter', desc:'上場時與回合結束時，將雙方手牌交換'}, attacks:[{name:'蟲刃剪',dmg:50,cost:2,type:'bug',rider:'type-draw',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'雷電',dmg:70,cost:5,type:'electric',rider:'energy-steal',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'空氣斬',dmg:100,cost:7,type:'flying',selfHeal:0.22,bonusVsType:'psychic'},{name:'飛葉快刀',dmg:96,cost:7,type:'grass',selfHeal:0.18,bonusVsType:'water',ignoreReflect:true}]},
  { mega:{spriteId:10308, type:'fighting', type2:'flying', ability:{id:'contrary-mirror', name:'唱反調', trigger:'onAttack', desc:'對方增傷與減傷的效果反過來計算'}}, id:398, name:'姆克鷹',       type:'normal',   type2:'flying',  hp:240, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}, attacks:[{name:'夜騷動',dmg:44,cost:1,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:4},{name:'暴風',dmg:63,cost:5,type:'flying',megaBoost:true,bonusEnergy:4},{name:'荒草吸能擊',dmg:70,cost:5,type:'grass',rider:'energy-steal'},{name:'神速吸能擊',dmg:89,cost:7,type:'normal',selfHeal:0.25,bonusVsType:'psychic',ignoreReflect:true,ignoreShield:true}]},
  { id:663, name:'烈箭鷹',       type:'fire',     type2:'flying',  hp:260, tier:2, ability:{id:'flame-body', name:'火焰之軀', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入燒傷，並且將場地切換為熔岩火山'}, attacks:[{name:'幽靈球',dmg:50,cost:2,type:'ghost',rider:'energy-steal',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'freeze',chance:0.4}},{name:'空氣斬',dmg:70,cost:5,type:'flying',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:7},{name:'荒草護甲擊',dmg:77,cost:5,type:'grass',rider:'mega-charge'},{name:'炎翼衝刺',dmg:96,cost:7,type:'fire',selfHeal:0.2,bonusVsType:'ghost',ignoreReflect:true}]},
  /* 蟲 */
  { mega:{spriteId:10047, type:'bug', type2:'fighting', ability:{id:'multi-strike', name:'連續攻擊', trigger:'onAttack', desc:'攻擊完後，會再以造成傷害 ×0.2 攻擊一次'}}, id:214, name:'赫拉克羅斯',   type:'bug',      type2:'fighting',hp:270, tier:2, ability:{id:'endure-once', name:'毅力', trigger:'onAttack', desc:'受到致命傷害時，有一次機會以1HP存活'}, attacks:[{name:'妖精強奪擊',dmg:68,cost:4,type:'fairy',rider:'mega-charge'},{name:'地震',dmg:88,cost:7,type:'ground',megaBoost:true,bonusEnergy:8,rider:'card-steal'},{name:'聖甲蟲衝擊',dmg:84,cost:7,type:'bug',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'近身戰',dmg:110,cost:8,type:'fighting',ignoreReflect:true,status:{effect:'sleep', chance:0.4},bonusVsType:'normal'}]},
  { mega:{spriteId:10046, type:'bug', type2:'steel', ability:{id:'technician', name:'技術高手', trigger:'onCard', desc:'使用卡牌時，回復5點能量、扣除對手5點能量'}}, id:212, name:'巨鉗螳螂',     type:'bug',      type2:'steel',   hp:260, tier:2, ability:{id:'bug-sense-dodge', name:'蟲之預感', trigger:'onAttack', desc:'對手攻擊時，可以抽取一張道具卡，並20%機率閃避對手攻擊'}, attacks:[{name:'疾風吸血擊',dmg:55,cost:2,type:'flying',ignoreReflect:true,rider:'life-drain'},{name:'破魂吸血擊',dmg:74,cost:6,type:'fighting',megaBoost:true,bonusEnergy:6},{name:'蟲刃剪',dmg:81,cost:6,type:'bug',megaBoost:true,bonusEnergy:5},{name:'子彈拳',dmg:101,cost:8,type:'steel',selfHeal:0.23,bonusVsType:'rock',ignoreReflect:true,ignoreShield:true}]},
  { id:469, name:'遠古巨蜓',     type:'bug',      type2:'flying',  hp:230, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'受到致命傷害時，有30%機率以1HP存活'}, attacks:[{name:'實力全開',dmg:61,cost:4,type:'normal',rider:'mega-charge',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'freeze',chance:0.4}},{name:'雷光威壓擊',dmg:68,cost:4,type:'electric',rider:'weaken'},{name:'蟲鳴',dmg:88,cost:7,type:'bug',megaBoost:true,bonusEnergy:7},{name:'空氣斬',dmg:107,cost:8,type:'flying',selfHeal:0.25,ignoreReflect:true,ignoreShield:true}]},
  /* 岩石 */
  { mega:{spriteId:10049, type:'rock', type2:'dark', ability:{id:'sandstorm-stadium-dodge', name:'揚沙', trigger:'onEnter', desc:'上場時場地切換為沙塵暴，並且有20%機率完全閃避攻擊'}}, id:248, name:'班基拉斯',     type:'rock',     type2:'dark',    hp:300, tier:2, ability:{id:'sandstorm-stadium-dodge', name:'揚沙', trigger:'onEnter', desc:'上場時場地切換為沙塵暴，並且有20%機率完全閃避攻擊'}, attacks:[{name:'碎岩',dmg:101,cost:8,type:'rock',rider:'move-reflect',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:8},{name:'咬碎',dmg:85,cost:6,type:'dark',ignoreReflect:true,status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'sleep',chance:0.4}},{name:'地震',dmg:53,cost:2,type:'ground',selfHeal:0.21},{name:'踢腿',dmg:100,cost:8,type:'fighting',status:{effect:'sleep', chance:0.4},bonusVsType:'dark',ignoreReflect:true}]},
  { mega:{spriteId:10042, type:'rock', type2:'flying', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:142, name:'化石翼龍',     type:'rock',     type2:'flying',  hp:260, tier:2, ability:{id:'flying-skin', name:'飛行皮膚', trigger:'onAttack', desc:'攻擊附帶飛行屬性傷害(計算傷害時，招式屬性以及飛行屬性攻擊擇優進行計算），10%機率閃避對手攻擊'}, attacks:[{name:'咬碎',dmg:58,cost:2,type:'dark',ignoreReflect:true,status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'paralysis',chance:0.4}},{name:'翼擊',dmg:82,cost:6,type:'flying',megaBoost:true,bonusEnergy:6},{name:'精神吸能擊',dmg:78,cost:6,type:'psychic',rider:'type-draw'},{name:'岩石炮',dmg:108,cost:8,type:'rock',selfHeal:0.2,bonusVsType:'ice',ignoreReflect:true}]},
  { id:526, name:'龐岩怪',       type:'rock',                      hp:280, tier:2, ability:{id:'rock-domain', name:'磐岩支配', trigger:'onEnter', desc:'上場時場地切換為岩石地帶；岩石屬性攻擊傷害額外 +40'}, attacks:[{name:'閃光炮',dmg:47,cost:1,type:'steel',rider:'type-draw',megaBoost:true,bonusEnergy:5},{name:'逆鱗護甲擊',dmg:71,cost:5,type:'dragon',rider:'energy-steal'},{name:'岩石炮',dmg:101,cost:7,type:'rock',status:{effect:'freeze', chance:0.4},bonusVsType:'rock'},{name:'地震',dmg:97,cost:7,type:'ground',status:{effect:'poison', chance:0.4},bonusVsType:'ice',ignoreReflect:true}]},
  /* 幽靈 */
  { id:477, name:'黑夜魔靈',     type:'ghost',                     hp:220, tier:1, ability:{id:'ghost-domain', name:'亡靈支配', trigger:'onEnter', desc:'上場時場地切換為亡靈墓園；幽靈屬性攻擊傷害額外 +40'}, attacks:[{name:'月亮力量',dmg:80,cost:6,type:'fairy',ignoreReflect:true,status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'sleep',chance:0.4}},{name:'冰凍拳',dmg:48,cost:2,type:'ice',rider:'mega-charge',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'paralysis',chance:0.4}},{name:'幽靈球',dmg:96,cost:8,type:'ghost',megaBoost:true,bonusEnergy:6},{name:'疾風強奪擊',dmg:51,cost:2,type:'flying',rider:'energy-steal'}]},
  { mega:{spriteId:10291, type:'ghost', type2:'fire', ability:{id:'penetrate', name:'穿透', trigger:'onAttack', desc:'攻擊完後，會再造成70傷害'}}, id:609, name:'水晶燈火靈',   type:'ghost',    type2:'fire',    hp:260, tier:2, ability:{id:'flash-fire', name:'引火', trigger:'onDefend', desc:'受到火屬性攻擊時完全免疫，下次攻擊威力 +50'}, attacks:[{name:'冰霜吸血擊',dmg:80,cost:6,type:'ice',rider:'life-drain'},{name:'空間扭曲',dmg:48,cost:2,type:'psychic',rider:'type-draw',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'confusion',chance:0.4}},{name:'暗影球',dmg:72,cost:6,type:'ghost',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'噴火',dmg:103,cost:8,type:'fire',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting',ignoreReflect:true}]},
  /* 惡 */
  { mega:{spriteId:10057, type:'dark', type2:null, ability:{id:'magic-mirror', name:'魔法鏡', trigger:'onAttack', desc:'反彈受到的負面狀態，並且回合結束有25%機率架起反彈鏡'}}, id:359, name:'阿勃梭魯',     type:'dark',                      hp:220, tier:1, ability:{id:'super-luck-draw', name:'超幸運', trigger:'onAttack', desc:'上場與回合開始時，有50%機率額外抽取兩張道具卡'}, attacks:[{name:'鐵尾',dmg:75,cost:6,type:'steel',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'光合作用強擊',dmg:59,cost:2,type:'grass',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'妖精威壓擊',dmg:55,cost:2,type:'fairy',rider:'energy-steal'},{name:'夜斬',dmg:98,cost:8,type:'dark',selfHeal:0.26,bonusVsType:'rock',ignoreReflect:true}]},
  // ── +30 新增（最終進化型，非幻獸/神獸，無龍/妖精屬性）──
  { id:865, name:'蔥遊兵', type:'fighting', hp:220, tier:1, ability:{id:'sudden-death', name:'背水之刃', trigger:'onAttack', desc:'受到致命傷時，與對手同歸於盡'}, attacks:[{name:'連續攻擊',dmg:57,cost:3,type:'normal',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'鋼影吸能擊',dmg:64,cost:3,type:'steel',ignoreReflect:true,rider:'energy-steal'},{name:'暗黑脈衝',dmg:83,cost:6,type:'dark',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'碎岩',dmg:102,cost:8,type:'fighting',selfHeal:0.18,bonusVsType:'ghost',ignoreReflect:true}]},
  { id:297, name:'鐵掌力士', type:'fighting', hp:250, tier:1, ability:{id:'fighting-domain', name:'鬥氣支配', trigger:'onEnter', desc:'上場時場地切換為羅馬鬥技場；格鬥屬性攻擊傷害額外 +40'}, attacks:[{name:'突擊',dmg:40,cost:1,type:'normal',ignoreReflect:true,megaBoost:true,bonusEnergy:5},{name:'魔法閃耀',dmg:75,cost:5,type:'fairy',megaBoost:true,bonusEnergy:5},{name:'近身戰',dmg:94,cost:7,type:'fighting',selfHeal:0.22,bonusVsType:'dark',ignoreReflect:true,ignoreShield:true},{name:'蟲毒護甲擊',dmg:78,cost:5,type:'bug',rider:'energy-steal'}]},
  { id:342, name:'鐵螯龍蝦', type:'water', type2:'dark', hp:210, tier:1, ability:{id:'adaptability-major', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.4（原本 ×1.1）'}, attacks:[{name:'神速強奪擊',dmg:42,cost:1,type:'normal',ignoreReflect:true,rider:'card-steal'},{name:'泥巴射擊',dmg:49,cost:1,type:'ground',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'水槍',dmg:73,cost:5,type:'water',megaBoost:true,bonusEnergy:6},{name:'夜斬',dmg:92,cost:7,type:'dark',status:{effect:'burn', chance:0.4},bonusVsType:'rock',ignoreReflect:true}]},
  { id:660, name:'掘地兔', type:'normal', type2:'ground', hp:230, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'受到致命傷害時，有30%機率以1HP存活'}, attacks:[{name:'岩崩',dmg:54,cost:3,type:'rock',rider:'self-cure',megaBoost:true,bonusEnergy:8},{name:'灼熱吸血擊',dmg:61,cost:3,type:'fire',rider:'type-draw'},{name:'衝撞',dmg:80,cost:6,type:'normal',megaBoost:true,bonusEnergy:7,rider:'life-drain'},{name:'地震',dmg:110,cost:8,type:'ground',ignoreReflect:true,selfHeal:0.21,bonusVsType:'fire'}]},
  { id:632, name:'鐵蟻', type:'steel', type2:'bug', hp:200, tier:1, ability:{id:'bug-domain', name:'蟲群支配', trigger:'onEnter', desc:'上場時場地切換為蟲群巢穴；蟲屬性攻擊傷害額外 +40'}, attacks:[{name:'冰霜威壓擊',dmg:73,cost:5,type:'ice',rider:'move-reflect'},{name:'電磁衝浪',dmg:46,cost:1,type:'electric',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'蟲咬',dmg:42,cost:1,type:'bug',megaBoost:true,bonusEnergy:5},{name:'金屬爪',dmg:95,cost:7,type:'steel',status:{effect:'paralysis', chance:0.4},bonusVsType:'water',ignoreReflect:true,ignoreShield:true}]},
  { id:558, name:'岩殿居蟹', type:'bug', type2:'rock', hp:240, tier:1, ability:{id:'endure-once', name:'淬鍊之心', trigger:'onAttack', desc:'受到致命傷害時，有一次機會以1HP存活'}, attacks:[{name:'烈火強衝',dmg:68,cost:5,type:'fire',rider:'energy-steal',megaBoost:true,bonusEnergy:4},{name:'荒草吸能擊',dmg:40,cost:0,type:'grass',rider:'self-cure'},{name:'岩石封鎖',dmg:71,cost:5,type:'rock',megaBoost:true,bonusEnergy:5},{name:'蟲咬',dmg:90,cost:7,type:'bug',ignoreReflect:true,status:{effect:'burn', chance:0.4},bonusVsType:'steel',ignoreShield:true}]},
  { id:105, name:'嘎啦嘎啦', type:'ground', hp:220, tier:1, ability:{id:'guts-cure-burst', name:'堅韌', trigger:'onAttack', desc:'回合開始時，若帶有異常狀態，解除異常狀態並且下次攻擊傷害 +20'}, attacks:[{name:'蟲毒護甲擊',dmg:50,cost:2,type:'bug',rider:'self-cure'},{name:'喊叫',dmg:57,cost:2,type:'normal',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'幽靈球',dmg:76,cost:6,type:'ghost',megaBoost:true,bonusEnergy:6},{name:'地震',dmg:96,cost:8,type:'ground',selfHeal:0.25,bonusVsType:'ghost',ignoreReflect:true,ignoreShield:true}]},
  { id:338, name:'太陽岩', type:'rock', type2:'psychic', hp:230, tier:1, ability:{id:'psychic-domain', name:'幻境支配', trigger:'onEnter', desc:'上場時場地切換為魔幻空間；超能力屬性攻擊傷害額外 +40'}, attacks:[{name:'夜襲',dmg:87,cost:7,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:7,ignoreReflect:true},{name:'念力',dmg:59,cost:4,type:'psychic',rider:'self-cure',megaBoost:true,bonusEnergy:7},{name:'岩石炮',dmg:110,cost:8,type:'rock',megaBoost:true,bonusEnergy:8,bonusVsType:'bug'},{name:'疾風強奪擊',dmg:62,cost:4,type:'flying',rider:'mega-charge'}]},
  { id:53, name:'貓老大', type:'normal', hp:210, tier:1, ability:{id:'normal-domain', name:'神域支配', trigger:'onEnter', desc:'上場時場地切換為莊嚴神社；一般屬性攻擊傷害額外 +40'}, attacks:[{name:'岩崩吸血擊',dmg:51,cost:2,type:'rock',rider:'energy-steal'},{name:'音爆拳',dmg:47,cost:2,type:'fighting',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'啃咬',dmg:78,cost:5,type:'dark',megaBoost:true,bonusEnergy:5,rider:'guard-up'},{name:'吼叫',dmg:97,cost:7,type:'normal',ignoreReflect:true,status:{effect:'confusion', chance:0.4},ignoreShield:true}]},
  { id:508, name:'長毛狗', type:'normal', hp:240, tier:1, ability:{id:'sudden-death', name:'背水之刃', trigger:'onAttack', desc:'受到致命傷時，與對手同歸於盡'}, attacks:[{name:'火焰牙',dmg:44,cost:1,type:'fire',rider:'energy-steal',megaBoost:true,bonusEnergy:4},{name:'龍之隕星',dmg:68,cost:5,type:'dragon',megaBoost:true,bonusEnergy:4,rider:'self-cure'},{name:'破魂威壓擊',dmg:75,cost:5,type:'fighting',ignoreReflect:true,rider:'weaken'},{name:'咬住',dmg:94,cost:7,type:'normal',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:5,bonusVsType:'grass'}]},
  { id:134, name:'水伊布', type:'water', hp:260, tier:1, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'冰凍光束',dmg:53,cost:2,type:'ice',rider:'mega-charge',megaBoost:true,bonusEnergy:6,bonusVsType:'rock'},{name:'岩石碎裂',dmg:72,cost:6,type:'fighting',megaBoost:true,bonusEnergy:6,rider:'move-reflect'},{name:'暗影吸能擊',dmg:79,cost:6,type:'dark',rider:'energy-steal'},{name:'水槍',dmg:99,cost:8,type:'water',ignoreReflect:true,status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:7}]},
  { mega:{spriteId:10090, type:'bug', type2:'poison', ability:{id:'adaptability-major', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.4（原本 ×1.1）'}}, id:15, name:'大針蜂', type:'bug', type2:'poison', hp:200, tier:1, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'閃電拳',dmg:43,cost:0,type:'electric',rider:'self-cure',megaBoost:true,bonusEnergy:5,bonusVsType:'dark'},{name:'毒針',dmg:40,cost:0,type:'poison',ignoreReflect:true,megaBoost:true,bonusEnergy:5},{name:'針刺',dmg:86,cost:7,type:'bug',megaBoost:true,bonusEnergy:5,bonusVsType:'water'},{name:'冰霜護甲擊',dmg:70,cost:5,type:'ice',rider:'self-cure'}]},
  { id:411, name:'護城龍', type:'rock', type2:'steel', hp:220, tier:1, ability:{id:'rock-domain', name:'磐岩支配', trigger:'onEnter', desc:'上場時場地切換為岩石地帶；岩石屬性攻擊傷害額外 +40'}, attacks:[{name:'金屬音',dmg:57,cost:2,type:'steel',rider:'type-draw',megaBoost:true,bonusEnergy:6,bonusVsType:'fairy'},{name:'頭槌',dmg:53,cost:2,type:'normal',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'岩崩',dmg:96,cost:8,type:'rock',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'妖精強奪擊',dmg:79,cost:6,type:'fairy',rider:'self-cure'}]},
  { mega:{spriteId:10064, type:'water', type2:'ground', ability:{id:'quick-feet', name:'飛毛腿', trigger:'onAttack', desc:'招式能量消耗-5，屬性加成（STAB）提升為 ×1.4'}}, id:260, name:'巨沼怪', type:'water', type2:'ground', hp:300, tier:2, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'精神吸血擊',dmg:52,cost:2,type:'psychic',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'泥巴射擊',dmg:87,cost:6,type:'ground',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'水槍',dmg:106,cost:8,type:'water',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting',ignoreReflect:true},{name:'冰凍拳',dmg:102,cost:8,type:'ice',status:{effect:'confusion', chance:0.4},bonusVsType:'flying'}]},
  { id:407, name:'羅絲雷朵', type:'grass', type2:'poison', hp:270, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'激流吸血擊',dmg:77,cost:6,type:'water',ignoreReflect:true,rider:'life-drain'},{name:'噴火',dmg:84,cost:6,type:'fire',megaBoost:true,bonusEnergy:7,rider:'weaken'},{name:'毒粉刺',dmg:57,cost:3,type:'poison',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'魔法葉',dmg:110,cost:8,type:'grass',status:{effect:'burn', chance:0.4},bonusVsType:'ice'}]},
  { id:724, name:'狙射樹梟', type:'grass', type2:'ghost', hp:290, tier:2, ability:{id:'grass-domain', name:'密林支配', trigger:'onEnter', desc:'上場時場地切換為邪惡森林；草屬性攻擊傷害額外 +40'}, attacks:[{name:'烈焰衝浪腳',dmg:51,cost:2,type:'fire',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'影子偷襲',dmg:75,cost:6,type:'ghost',rider:'type-draw',megaBoost:true,bonusEnergy:6},{name:'飛葉快刀',dmg:106,cost:8,type:'grass',status:{effect:'burn', chance:0.4},bonusVsType:'ice',ignoreReflect:true},{name:'猛禽炸彈',dmg:102,cost:8,type:'flying',selfHeal:0.25,bonusVsType:'fighting'}]},
  { id:452, name:'龍王蠍', type:'poison', type2:'dark', hp:280, tier:2, ability:{id:'poison-domain', name:'劇毒支配', trigger:'onEnter', desc:'上場時場地切換為劇毒領域；毒屬性攻擊傷害額外 +40'}, attacks:[{name:'毒針',dmg:40,cost:0,type:'poison',ignoreReflect:true,status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:4,status2:{effect:'sleep',chance:0.4}},{name:'夜斬',dmg:95,cost:7,type:'dark',megaBoost:true,bonusEnergy:4},{name:'疾風威壓擊',dmg:68,cost:5,type:'flying',rider:'energy-steal'},{name:'地震',dmg:87,cost:7,type:'ground',status:{effect:'sleep', chance:0.4},bonusVsType:'rock',ignoreReflect:true}]},
  { id:862, name:'堵攔熊', type:'dark', type2:'normal', hp:300, tier:2, ability:{id:'guts-cure-burst', name:'堅韌', trigger:'onAttack', desc:'回合開始時，若帶有異常狀態，解除異常狀態並且下次攻擊傷害 +20'}, attacks:[{name:'空間扭曲',dmg:85,cost:6,type:'dragon',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'高周波音',dmg:58,cost:3,type:'normal',rider:'mega-charge',megaBoost:true,bonusEnergy:6},{name:'未來雷霆',dmg:100,cost:8,type:'psychic',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting'},{name:'夜斬',dmg:107,cost:8,type:'dark',selfHeal:0.2,bonusVsType:'dragon',ignoreReflect:true}]},
  { id:738, name:'鍬農炮蟲', type:'bug', type2:'electric', hp:270, tier:2, ability:{id:'sudden-death', name:'背水之刃', trigger:'onAttack', desc:'受到致命傷時，與對手同歸於盡'}, attacks:[{name:'蟲咬',dmg:56,cost:3,type:'bug',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'電磁炮',dmg:109,cost:8,type:'electric',megaBoost:true,bonusEnergy:8,bonusVsType:'water'},{name:'幽冥威壓擊',dmg:82,cost:6,type:'ghost',megaBoost:true,bonusEnergy:7,rider:'type-draw'},{name:'妖精吸能擊',dmg:78,cost:6,type:'fairy',ignoreReflect:true,rider:'energy-steal'}]},
  { mega:{spriteId:10313, type:'ground', type2:'ghost', ability:{id:'mega-launcher', name:'隱形拳', trigger:'onCard', desc:'使用卡牌時，會對對手寶可夢造成50傷害'}}, id:623, name:'泥偶巨人', type:'ground', type2:'ghost', hp:310, tier:2, ability:{id:'retaliate-boost', name:'反骨', trigger:'onAttack', desc:'上場與回合開始時，額外獲得5點能量'}, attacks:[{name:'百萬針',dmg:85,cost:7,type:'bug',rider:'mega-charge',megaBoost:true,bonusEnergy:8},{name:'幽靈球',dmg:68,cost:4,type:'ghost',rider:'self-cure',megaBoost:true,bonusEnergy:8},{name:'大地虹吸',dmg:110,cost:8,type:'ground',selfHeal:0.22,bonusVsType:'psychic'},{name:'冰霜拳',dmg:107,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'grass',ignoreReflect:true}]},
  { mega:{spriteId:10280, type:'water', type2:'psychic', ability:{id:'protean-max', name:'大力士', trigger:'onAttack', desc:'攻擊一律視為克制對手的屬性'}}, id:121, name:'寶石海星', type:'water', type2:'psychic', hp:270, tier:2, ability:{id:'mystic-guard', name:'神秘防守', trigger:'onDefend', desc:'受到攻擊時，擲一枚硬幣，如果正面，受到的傷害x0.75'}, attacks:[{name:'近身戰',dmg:82,cost:7,type:'fighting',rider:'type-draw',megaBoost:true,bonusEnergy:8},{name:'精神強擊',dmg:89,cost:7,type:'psychic',megaBoost:true,bonusEnergy:8},{name:'蟲毒護甲擊',dmg:61,cost:4,type:'bug',rider:'self-cure'},{name:'水槍',dmg:110,cost:8,type:'water',ignoreReflect:true,selfHeal:0.15,bonusVsType:'ice',ignoreShield:true}]},
  { mega:{spriteId:10045, type:'electric', type2:'dragon', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對手特性'}}, id:181, name:'電龍', type:'electric', hp:300, tier:2, ability:{id:'static-paralyze-dual', name:'靜電', trigger:'onEnter', desc:'上場時麻痺對手，並且攻擊附帶電屬性傷害（計算傷害時，招式屬性以及電屬性攻擊擇優進行計算）'}, attacks:[{name:'精神護甲擊',dmg:64,cost:3,type:'psychic',rider:'type-draw',megaBoost:true,bonusEnergy:6},{name:'衝撞',dmg:83,cost:6,type:'normal',megaBoost:true,bonusEnergy:6},{name:'冰霜護甲擊',dmg:102,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'電擊',dmg:109,cost:8,type:'electric',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting',ignoreReflect:true}]},
  { mega:{spriteId:10316, type:'bug', type2:'steel', ability:{id:'heavy-armor', name:'重甲化', trigger:'onCard', desc:'使用道具卡時，獲得減傷30 （可以疊加）'}}, id:768, name:'具甲武者', type:'bug', type2:'water', hp:290, tier:2, ability:{id:'retaliate-boost', name:'反骨', trigger:'onAttack', desc:'上場與回合開始時，額外獲得5點能量'}, attacks:[{name:'聖焰',dmg:75,cost:5,type:'fire',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'蟲咬',dmg:43,cost:1,type:'bug',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'大浪',dmg:101,cost:7,type:'water',selfHeal:0.17,bonusVsType:'ice'},{name:'雷光威壓擊',dmg:97,cost:7,type:'electric',status:{effect:'paralysis', chance:0.4},bonusVsType:'water',ignoreReflect:true}]},
  { id:465, name:'巨蔓藤', type:'grass', hp:310, tier:2, ability:{id:'grass-domain', name:'密林支配', trigger:'onEnter', desc:'上場時場地切換為邪惡森林；草屬性攻擊傷害額外 +40'}, attacks:[{name:'實力全開',dmg:60,cost:3,type:'normal',rider:'self-cure',megaBoost:true,bonusEnergy:7},{name:'灼熱吸血擊',dmg:79,cost:6,type:'fire',ignoreReflect:true,megaBoost:true,bonusEnergy:8},{name:'光合作用強擊',dmg:109,cost:8,type:'grass',status:{effect:'confusion', chance:0.4},ignoreReflect:true},{name:'惡意突刺',dmg:105,cost:8,type:'poison',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true}]},
  { id:713, name:'冰岩怪', type:'ice', hp:320, tier:2, ability:{id:'frozen-body', name:'冰凍之軀', trigger:'onDefend', desc:'受到攻擊時，賦予對手結凍，並且將場地切換為永凍冰原'}, attacks:[{name:'毒液',dmg:98,cost:7,type:'poison',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:4},{name:'碎岩',dmg:94,cost:7,type:'rock',ignoreReflect:true,selfHeal:0.24,bonusVsType:'flying',ignoreShield:true},{name:'雪崩',dmg:101,cost:7,type:'ice',status:{effect:'poison', chance:0.4},bonusVsType:'grass'},{name:'光合作用強擊',dmg:74,cost:5,type:'grass',rider:'mega-charge',selfHeal:0.17}]},
  { id:576, name:'哥德小姐', type:'psychic', hp:280, tier:2, ability:{id:'penetrate', name:'穿透', trigger:'onAttack', desc:'攻擊完後，會再造成70傷害'}, attacks:[{name:'冰耳光',dmg:43,cost:0,type:'ice',rider:'type-draw',megaBoost:true,bonusEnergy:5},{name:'雷光強奪擊',dmg:67,cost:5,type:'electric',rider:'energy-steal'},{name:'幽冥威壓擊',dmg:86,cost:7,type:'ghost',selfHeal:0.2,bonusVsType:'ghost'},{name:'念力',dmg:93,cost:7,type:'psychic',ignoreReflect:true,status:{effect:'freeze', chance:0.4},bonusVsType:'flying'}]},
  { mega:{spriteId:10048, type:'dark', type2:'fire', ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:229, name:'黑魯加', type:'fire', type2:'dark', hp:280, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'水之脈動',dmg:47,cost:1,type:'water',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'火焰牙',dmg:94,cost:7,type:'fire',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:5,bonusVsType:'ice'},{name:'惡意波動',dmg:101,cost:7,type:'dark',ignoreReflect:true,selfHeal:0.26,bonusVsType:'ground'},{name:'精神吸血擊',dmg:74,cost:5,type:'psychic',rider:'self-cure'}]},
  { id:464, name:'超甲狂犀', type:'ground', type2:'rock', hp:360, tier:3, ability:{id:'ground-domain', name:'風沙支配', trigger:'onEnter', desc:'上場時場地切換為沙塵暴；地面屬性攻擊傷害額外 +40'}, attacks:[{name:'角撞',dmg:104,cost:8,type:'normal',ignoreReflect:true,megaBoost:true,bonusEnergy:8},{name:'泥巴射擊',dmg:100,cost:8,type:'ground',selfHeal:0.18},{name:'岩崩',dmg:107,cost:8,type:'rock',status:{effect:'confusion', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'惡意突刺',dmg:80,cost:6,type:'poison',rider:'self-cure',status:{effect:'poison', chance:0.4},status2:{effect:'confusion',chance:0.4}}]},
  { id:473, name:'象牙豬', type:'ice', type2:'ground', hp:235, tier:3, ability:{id:'snowfall', name:'降雪', trigger:'onEnter', desc:'上場時，將場地切換為永凍冰原，並且每回合給予對手寶可夢50HP 傷害'}, attacks:[{name:'雪崩',dmg:63,cost:5,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6,bonusVsType:'ground'},{name:'地震',dmg:93,cost:7,type:'ground',selfHeal:0.28,bonusVsType:'steel'},{name:'啃咬',dmg:66,cost:5,type:'dark',status:{effect:'freeze', chance:0.4},selfHeal:0.25,status2:{effect:'sleep',chance:0.4}},{name:'毒針',dmg:45,cost:0,type:'poison',rider:'mega-charge',status:{effect:'poison', chance:0.4},status2:{effect:'freeze',chance:0.4}}]},
  { id:625, name:'劈斬司令', type:'dark', type2:'steel', hp:295, tier:3, ability:{id:'guts-cure-burst', name:'堅韌', trigger:'onAttack', desc:'回合開始時，若帶有異常狀態，解除異常狀態並且下次攻擊傷害 +20'}, attacks:[{name:'金屬爪',dmg:103,cost:8,type:'steel',megaBoost:true,bonusEnergy:5,bonusVsType:'ice'},{name:'夜斬',dmg:99,cost:8,type:'dark',ignoreReflect:true,selfHeal:0.16,bonusVsType:'ghost'},{name:'水炮',dmg:59,cost:2,type:'water',rider:'mega-charge',selfHeal:0.23},{name:'念力衝擊',dmg:78,cost:6,type:'psychic',rider:'type-draw',selfHeal:0.3}]},
  /* ── Mega 進化擴充（Legends Z-A / 原有 46 種缺漏補完） ── */
  { mega:{spriteId:10073, type:'normal', type2:'flying', ability:{id:'shadow-tag-pierce', name:'無防守', trigger:'onAttack', desc:'攻擊不會被對手減傷，也不會對手閃避'}}, id:18, name:'大比鳥', type:'normal', type2:'flying', hp:220, tier:1, ability:{id:'arena-trap', name:'牽制', trigger:'onAttack', desc:'對手不能換其他寶可夢上場'}, attacks:[{name:'幽冥威壓擊',dmg:52,cost:2,type:'ghost',rider:'energy-steal',megaBoost:true,bonusEnergy:6,bonusVsType:'bug'},{name:'電光一閃',dmg:59,cost:2,type:'normal',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'破空飛翔',dmg:102,cost:8,type:'flying',megaBoost:true,bonusEnergy:6,bonusVsType:'ghost'},{name:'劇毒威壓擊',dmg:74,cost:6,type:'poison',rider:'weaken'}]},
  { mega:{spriteId:10039, type:'normal', type2:null, ability:{id:'multi-strike', name:'親子羈絆', trigger:'onAttack', desc:'攻擊完後，會再以造成傷害 ×0.2 攻擊一次'}}, id:115, name:'袋獸', type:'normal', hp:280, tier:2, ability:{id:'endure-once', name:'淬鍊之心', trigger:'onAttack', desc:'受到致命傷害時，有一次機會以1HP存活'}, attacks:[{name:'地震',dmg:50,cost:1,type:'ground',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'咬碎',dmg:97,cost:7,type:'dark',megaBoost:true,bonusEnergy:5},{name:'破魂吸能擊',dmg:70,cost:5,type:'fighting',ignoreReflect:true,rider:'energy-steal'},{name:'拍打',dmg:100,cost:7,type:'normal',status:{effect:'sleep', chance:0.4},bonusVsType:'steel',ignoreReflect:true}]},
  { mega:{spriteId:10040, type:'bug', type2:'flying', ability:{id:'flying-skin', name:'飛行皮膚', trigger:'onAttack', desc:'攻擊附帶飛行屬性傷害(計算傷害時，招式屬性以及飛行屬性攻擊擇優進行計算），10%機率閃避對手攻擊'}}, id:127, name:'凱羅斯', type:'bug', hp:210, tier:1, ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對手特性'}, attacks:[{name:'石頭砸落',dmg:45,cost:2,type:'rock',ignoreReflect:true,megaBoost:true,bonusEnergy:5,rider:'self-cure'},{name:'精神護甲擊',dmg:52,cost:2,type:'psychic',rider:'mega-charge'},{name:'綁緊',dmg:76,cost:6,type:'normal',megaBoost:true,bonusEnergy:5,rider:'card-steal'},{name:'斷頭台',dmg:96,cost:8,type:'bug',status:{effect:'confusion', chance:0.4},bonusVsType:'flying'}]},
  { mega:{spriteId:10072, type:'steel', type2:'ground', ability:{id:'sandstorm-stadium-dodge', name:'揚沙', trigger:'onEnter', desc:'上場時場地切換為沙塵暴，並且有20%機率完全閃避攻擊'}}, id:208, name:'大鋼蛇', type:'steel', type2:'ground', hp:290, tier:2, ability:{id:'item-synergy', name:'機械之心', trigger:'onAttack', desc:'本回合使用過道具卡時，攻擊傷害 +40，並且下回合對手造成的傷害-50'}, attacks:[{name:'綁緊',dmg:58,cost:2,type:'normal',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'大浪',dmg:77,cost:6,type:'water',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'地震',dmg:97,cost:8,type:'ground',selfHeal:0.17,bonusVsType:'poison'},{name:'鐵尾',dmg:104,cost:8,type:'steel',selfHeal:0.2,bonusVsType:'ground',ignoreReflect:true}]},
  { mega:{spriteId:10050, type:'fire', type2:'fighting', ability:{id:'acceleration', name:'加速', trigger:'onCard', desc:'使用道具卡時，獲得5能量，若這回合使用>8能量，傷害+40'}}, id:257, name:'火焰雞', type:'fire', type2:'fighting', hp:260, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'冰霜強奪擊',dmg:80,cost:6,type:'ice',ignoreReflect:true,megaBoost:true,bonusEnergy:7,rider:'move-reflect'},{name:'火花',dmg:53,cost:2,type:'fire',megaBoost:true,bonusEnergy:7,rider:'guard-up'},{name:'居合斬',dmg:72,cost:6,type:'dark',megaBoost:true,bonusEnergy:7,rider:'weaken'},{name:'踢腿',dmg:103,cost:8,type:'fighting',rider:'move-reflect'}]},
  { mega:{spriteId:10066, type:'dark', type2:'ghost', ability:{id:'magic-mirror', name:'魔法鏡', trigger:'onAttack', desc:'反彈受到的負面狀態，並且回合結束有25%機率架起反彈鏡'}}, id:302, name:'勾魂眼', type:'dark', type2:'ghost', hp:200, tier:1, ability:{id:'contrary-heart', name:'顛倒之心', trigger:'onAttack', desc:'雙方的卡牌效果都反過來'}, attacks:[{name:'暗影球',dmg:50,cost:1,type:'ghost',ignoreReflect:true,megaBoost:true,bonusEnergy:5},{name:'蟲毒吸血擊',dmg:46,cost:1,type:'bug',ignoreReflect:true,rider:'life-drain'},{name:'寶石爆破',dmg:70,cost:5,type:'rock',megaBoost:true,bonusEnergy:5},{name:'暗黑爆破',dmg:100,cost:7,type:'dark',selfHeal:0.25,bonusVsType:'psychic',ignoreReflect:true}]},
  { mega:{spriteId:10052, type:'steel', type2:'fairy', ability:{id:'protean-max', name:'大力士', trigger:'onAttack', desc:'攻擊一律視為克制對手的屬性'}}, id:303, name:'大嘴娃', type:'steel', type2:'fairy', hp:200, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}, attacks:[{name:'啃咬',dmg:40,cost:0,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:4},{name:'毒牙',dmg:43,cost:0,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:4},{name:'幽冥威壓擊',dmg:67,cost:5,type:'ghost',rider:'weaken'},{name:'鐵頭',dmg:86,cost:7,type:'steel',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true}]},
  { mega:{spriteId:10053, type:'steel', type2:null, ability:{id:'sturdy-30pct', name:'結實', trigger:'onAttack', desc:'HP>30%時，有一次機會以1HP存活'}}, id:306, name:'波士可多拉', type:'steel', type2:'rock', hp:200, tier:2, ability:{id:'sturdy-30pct', name:'結實', trigger:'onAttack', desc:'HP>30%時，有一次機會以1HP存活'}, attacks:[{name:'雪崩',dmg:47,cost:1,type:'ice',rider:'self-cure',megaBoost:true,bonusEnergy:8},{name:'岩石滑落',dmg:43,cost:1,type:'rock',rider:'energy-steal',megaBoost:true,bonusEnergy:8},{name:'幽冥威壓擊',dmg:73,cost:5,type:'ghost',selfHeal:0.18,bonusVsType:'ghost'},{name:'金屬爪',dmg:92,cost:7,type:'steel',status:{effect:'freeze', chance:0.4},bonusVsType:'ground',ignoreReflect:true}]},
  { mega:{spriteId:10054, type:'fighting', type2:'psychic', ability:{id:'fighting-flat-bonus', name:'驚人怪力', trigger:'onAttack', desc:'鬥屬性招式傷害+20'}}, id:308, name:'恰雷姆', type:'fighting', type2:'psychic', hp:210, tier:1, ability:{id:'fighting-flat-bonus', name:'驚人怪力', trigger:'onAttack', desc:'鬥屬性招式傷害+20'}, attacks:[{name:'惡意彈珠',dmg:44,cost:2,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:5},{name:'念力',dmg:51,cost:2,type:'psychic',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'岩崩吸能擊',dmg:71,cost:5,type:'rock',rider:'energy-steal'},{name:'氣功拳',dmg:101,cost:7,type:'fighting',ignoreReflect:true,selfHeal:0.3,bonusVsType:'psychic'}]},
  { mega:{spriteId:10055, type:'electric', type2:null, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}}, id:310, name:'雷電獸', type:'electric', hp:230, tier:1, ability:{id:'static-paralyze-dual', name:'靜電', trigger:'onEnter', desc:'上場時麻痺對手，並且攻擊附帶電屬性傷害（計算傷害時，招式屬性以及電屬性攻擊擇優進行計算）'}, attacks:[{name:'火焰牙',dmg:62,cost:4,type:'fire',rider:'energy-steal',megaBoost:true,bonusEnergy:8},{name:'大地護甲擊',dmg:58,cost:4,type:'ground',ignoreReflect:true,rider:'guard-up'},{name:'吼叫',dmg:89,cost:7,type:'normal',megaBoost:true,bonusEnergy:8,rider:'mega-charge'},{name:'十萬伏特',dmg:108,cost:8,type:'electric',selfHeal:0.26,bonusVsType:'steel'}]},
  { mega:{spriteId:10070, type:'water', type2:'dark', ability:{id:'dark-jaw-discard', name:'強壯之顎', trigger:'onAttack', desc:'惡屬性招式傷害x1.4，攻擊後30%棄掉對手一張手牌'}}, id:319, name:'巨牙鯊', type:'water', type2:'dark', hp:220, tier:1, ability:{id:'rough-skin', name:'粗糙皮膚', trigger:'onDefend', desc:'受到攻擊傷害時，反彈攻擊者 1/8 最大HP 傷害'}, attacks:[{name:'冰牙',dmg:54,cost:3,type:'ice',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'劇毒強奪擊',dmg:84,cost:6,type:'poison',rider:'move-reflect'},{name:'咬碎',dmg:57,cost:3,type:'dark',megaBoost:true,bonusEnergy:8},{name:'衝浪',dmg:110,cost:8,type:'water',selfHeal:0.18,bonusVsType:'grass',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10087, type:'fire', type2:'ground', ability:{id:'drought-lava', name:'熔岩大地', trigger:'onEnter', desc:'上場時場地切換為熔岩火山；地面／火屬性攻擊傷害額外 +40'}}, id:323, name:'噴火駝', type:'fire', type2:'ground', hp:260, tier:2, ability:{id:'solid-rock-flat', name:'硬岩', trigger:'onDefend', desc:'受到的傷害-30'}, attacks:[{name:'鐵頭',dmg:57,cost:2,type:'steel',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'泥巴射擊',dmg:76,cost:6,type:'ground',megaBoost:true,bonusEnergy:6},{name:'幽冥吸血擊',dmg:72,cost:6,type:'ghost',ignoreReflect:true,rider:'life-drain'},{name:'火花',dmg:103,cost:8,type:'fire',status:{effect:'sleep', chance:0.4},bonusVsType:'rock',ignoreReflect:true}]},
  { mega:{spriteId:10067, type:'dragon', type2:'fairy', ability:{id:'fairy-skin', name:'妖精皮膚', trigger:'onAttack', desc:'攻擊附帶妖精屬性傷害(計算傷害時，招式屬性以及妖精屬性攻擊擇優進行計算），受到攻擊時，賦予對手混亂'}}, id:334, name:'七夕青鳥', type:'dragon', type2:'flying', hp:270, tier:2, ability:{id:'natural-cure', name:'自然回復', trigger:'onAttack', desc:'每回合回復70HP'}, attacks:[{name:'劇毒強奪擊',dmg:66,cost:4,type:'poison',rider:'mega-charge',megaBoost:true,bonusEnergy:7,bonusVsType:'fighting'},{name:'龍之氣息',dmg:86,cost:7,type:'dragon',megaBoost:true,bonusEnergy:8,rider:'mega-charge'},{name:'啄',dmg:105,cost:8,type:'flying',megaBoost:true,bonusEnergy:7,bonusVsType:'fairy'},{name:'荒草威壓擊',dmg:89,cost:7,type:'grass',rider:'type-draw'}]},
  { mega:{spriteId:10056, type:'ghost', type2:null, ability:{id:'mischief-heart', name:'惡作劇之心', trigger:'onEnter', desc:'上場時與回合結束時，將雙方手牌交換'}}, id:354, name:'詛咒娃娃', type:'ghost', hp:210, tier:1, ability:{id:'contrary-heart', name:'顛倒之心', trigger:'onAttack', desc:'雙方的卡牌效果都反過來'}, attacks:[{name:'空間扭曲',dmg:44,cost:1,type:'psychic',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'雷光吸能擊',dmg:40,cost:1,type:'electric',rider:'type-draw'},{name:'暗黑爆破',dmg:75,cost:5,type:'dark',megaBoost:true,bonusEnergy:5,rider:'life-drain'},{name:'暗影球',dmg:94,cost:7,type:'ghost',ignoreReflect:true,selfHeal:0.19,bonusVsType:'poison'}]},
  { mega:{spriteId:10074, type:'ice', type2:null, ability:{id:'ice-skin', name:'冰肌', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.4，受到攻擊時，賦予對手結凍'}}, id:362, name:'冰鬼護', type:'ice', hp:260, tier:2, ability:{id:'frozen-body', name:'冰凍之軀', trigger:'onDefend', desc:'受到攻擊時，賦予對手結凍，並且將場地切換為永凍冰原'}, attacks:[{name:'暗黑爆破',dmg:81,cost:6,type:'dark',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'激流護甲擊',dmg:54,cost:2,type:'water',rider:'mega-charge'},{name:'鐵頭',dmg:73,cost:6,type:'steel',megaBoost:true,bonusEnergy:6},{name:'冰耳光',dmg:104,cost:8,type:'ice',selfHeal:0.2,bonusVsType:'psychic',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10089, type:'dragon', type2:'flying', ability:{id:'flying-skin', name:'飛行皮膚', trigger:'onAttack', desc:'攻擊附帶飛行屬性傷害(計算傷害時，招式屬性以及飛行屬性攻擊擇優進行計算），10%機率閃避對手攻擊'}}, id:373, name:'暴飛龍', type:'dragon', type2:'flying', hp:220, tier:3, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}, attacks:[{name:'咬碎',dmg:86,cost:6,type:'dark',megaBoost:true,bonusEnergy:6,bonusVsType:'psychic',ignoreReflect:true},{name:'冰霜吸血擊',dmg:59,cost:3,type:'ice',selfHeal:0.27},{name:'龍之氣息',dmg:101,cost:8,type:'dragon',status:{effect:'freeze', chance:0.4},bonusVsType:'flying'},{name:'燕返',dmg:62,cost:3,type:'flying',rider:'mega-charge',status:{effect:'confusion', chance:0.4},status2:{effect:'sleep',chance:0.4}}]},
  { mega:{spriteId:10062, type:'dragon', type2:'psychic', ability:{id:'levitate', name:'飄浮', trigger:'onDefend', desc:'受到地面屬性攻擊時完全免疫，並且10%機率閃避對手攻擊'}}, id:380, name:'拉帝亞斯', type:'dragon', type2:'psychic', hp:320, tier:3, ability:{id:'levitate', name:'飄浮', trigger:'onDefend', desc:'受到地面屬性攻擊時完全免疫，並且10%機率閃避對手攻擊'}, attacks:[{name:'念力',dmg:92,cost:7,type:'psychic',megaBoost:true,bonusEnergy:4},{name:'龍之氣息',dmg:99,cost:7,type:'dragon',status:{effect:'sleep', chance:0.4},bonusVsType:'dragon'},{name:'魔法閃耀',dmg:95,cost:7,type:'fairy',status:{effect:'freeze', chance:0.4},bonusVsType:'fighting',ignoreReflect:true},{name:'熔岩爆發',dmg:68,cost:5,type:'fire',rider:'type-draw',status:{effect:'burn', chance:0.4},status2:{effect:'poison',chance:0.4}}]},
  { mega:{spriteId:10063, type:'dragon', type2:'psychic', ability:{id:'levitate', name:'飄浮', trigger:'onDefend', desc:'受到地面屬性攻擊時完全免疫，並且10%機率閃避對手攻擊'}}, id:381, name:'拉帝歐斯', type:'dragon', type2:'psychic', hp:320, tier:3, ability:{id:'levitate', name:'飄浮', trigger:'onDefend', desc:'受到地面屬性攻擊時完全免疫，並且10%機率閃避對手攻擊'}, attacks:[{name:'龍之隕星',dmg:94,cost:7,type:'dragon',megaBoost:true,bonusEnergy:4},{name:'念力',dmg:101,cost:7,type:'psychic',status:{effect:'burn', chance:0.4},bonusVsType:'fighting',ignoreReflect:true},{name:'冷凍光線',dmg:97,cost:7,type:'ice',selfHeal:0.23,bonusVsType:'flying',ignoreReflect:true,ignoreShield:true},{name:'地震',dmg:70,cost:5,type:'ground',selfHeal:0.16}]},
  { mega:{spriteId:10088, type:'normal', type2:'fighting', ability:{id:'endure-once', name:'根性', trigger:'onAttack', desc:'受到致命傷害時，有一次機會以1HP存活'}}, id:428, name:'長耳兔', type:'normal', hp:220, tier:1, ability:{id:'cute-charm-confuse', name:'魅力', trigger:'onAttack', desc:'上場時，對手遭到混亂；受到攻擊時，有40%機率受到的傷害x0.8'}, attacks:[{name:'岩石碎裂',dmg:86,cost:6,type:'fighting',rider:'energy-steal',megaBoost:true,bonusEnergy:6,ignoreReflect:true},{name:'連續切',dmg:59,cost:3,type:'bug',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'破壞光線',dmg:101,cost:8,type:'normal',megaBoost:true,bonusEnergy:6,bonusVsType:'normal'},{name:'精神強奪擊',dmg:62,cost:3,type:'psychic',rider:'mega-charge'}]},
  { mega:{spriteId:10060, type:'grass', type2:'ice', ability:{id:'snowfall', name:'降雪', trigger:'onEnter', desc:'上場時，將場地切換為永凍冰原，並且每回合給予對手寶可夢50HP 傷害'}}, id:460, name:'暴雪王', type:'grass', type2:'ice', hp:280, tier:2, ability:{id:'snowfall', name:'降雪', trigger:'onEnter', desc:'上場時，將場地切換為永凍冰原，並且每回合給予對手寶可夢50HP 傷害'}, attacks:[{name:'劇毒強奪擊',dmg:47,cost:1,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'魔法葉',dmg:94,cost:7,type:'grass',megaBoost:true,bonusEnergy:4},{name:'冰霜拳',dmg:101,cost:7,type:'ice',ignoreReflect:true,status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreShield:true},{name:'破魂吸血擊',dmg:74,cost:5,type:'fighting',rider:'type-draw'}]},
  { mega:{spriteId:10068, type:'psychic', type2:'fighting', ability:{id:'mind-power', name:'精神力', trigger:'passive', desc:'不會被對手卡牌效果影響'}}, id:475, name:'艾路雷朵', type:'psychic', type2:'fighting', hp:260, tier:2, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'受到致命傷害時，有30%機率以1HP存活'}, attacks:[{name:'十萬伏特',dmg:81,cost:6,type:'electric',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'念力',dmg:77,cost:6,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'妖精威壓擊',dmg:61,cost:3,type:'fairy',rider:'mega-charge'},{name:'踢腿',dmg:103,cost:8,type:'fighting',ignoreReflect:true,status:{effect:'paralysis', chance:0.4},bonusVsType:'flying',ignoreShield:true}]},
  { mega:{spriteId:10069, type:'normal', type2:'fairy', ability:{id:'healing-heart', name:'治癒之心', trigger:'onCard', desc:'使用道具卡時，回復20%HP'}}, id:531, name:'差不多娃娃', type:'normal', hp:300, tier:2, ability:{id:'recovery-power', name:'回復力', trigger:'onAttack', desc:'攻擊時，回復傷害60%HP'}, attacks:[{name:'魔法閃耀',dmg:55,cost:2,type:'fairy',rider:'type-draw',megaBoost:true,bonusEnergy:6},{name:'大地護甲擊',dmg:74,cost:6,type:'ground',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'拍打',dmg:105,cost:8,type:'normal',selfHeal:0.28,bonusVsType:'dark'},{name:'日光束',dmg:101,cost:8,type:'grass',selfHeal:0.29,bonusVsType:'ground',ignoreReflect:true}]},
  { mega:{spriteId:10075, type:'rock', type2:'fairy', ability:{id:'magic-mirror', name:'魔法鏡', trigger:'onAttack', desc:'反彈受到的負面狀態，並且回合結束有25%機率架起反彈鏡'}}, id:719, name:'蒂安希', type:'rock', type2:'fairy', hp:300, tier:3, ability:{id:'purity-body', name:'恆淨之軀', trigger:'onEnter', desc:'上場與回合開始時，清掉場地以及對手特性的效果'}, attacks:[{name:'閃光炮',dmg:85,cost:6,type:'steel',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'魔法閃耀',dmg:58,cost:3,type:'fairy',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'破魂強奪擊',dmg:100,cost:8,type:'fighting',status:{effect:'sleep', chance:0.4},bonusVsType:'steel'},{name:'岩石滑落',dmg:107,cost:8,type:'rock',selfHeal:0.21,bonusVsType:'rock',ignoreReflect:true}]},
  { mega:{spriteId:10278, type:'fairy', type2:'flying', ability:{id:'magic-mirror', name:'魔法鏡', trigger:'onAttack', desc:'反彈受到的負面狀態，並且回合結束有25%機率架起反彈鏡'}}, id:36, name:'皮可西', type:'fairy', hp:280, tier:2, ability:{id:'magic-guard', name:'魔法防守', trigger:'onAttack', desc:'不會被賦予負面狀態，受到攻擊時有50%機率傷害x0.5'}, attacks:[{name:'拍打',dmg:46,cost:1,type:'normal',rider:'type-draw',megaBoost:true,bonusEnergy:5},{name:'疾風吸能擊',dmg:65,cost:5,type:'flying',rider:'energy-steal'},{name:'妖精吸能擊',dmg:95,cost:7,type:'fairy',selfHeal:0.2,bonusVsType:'dark'},{name:'毒液',dmg:91,cost:7,type:'poison',ignoreReflect:true,status:{effect:'poison', chance:0.4},bonusVsType:'grass'}]},
  { mega:{spriteId:10279, type:'grass', type2:'poison', ability:{id:'sudden-death', name:'揭露之貌', trigger:'onDefend', desc:'受到致命傷時，與對手同歸於盡'}}, id:71, name:'大食花', type:'grass', type2:'poison', hp:230, tier:1, ability:{id:'adaptability-major', name:'葉綠素', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.4'}, attacks:[{name:'激流護甲擊',dmg:68,cost:4,type:'water',rider:'type-draw'},{name:'鐵頭',dmg:64,cost:4,type:'steel',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'葉刃',dmg:84,cost:7,type:'grass',megaBoost:true,bonusEnergy:7},{name:'惡意突刺',dmg:110,cost:8,type:'poison',status:{effect:'sleep', chance:0.4},bonusVsType:'rock',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10284, type:'steel', type2:'flying', ability:{id:'sudden-death', name:'頑強', trigger:'onAttack', desc:'受到致命傷時，與對手同歸於盡'}}, id:227, name:'盔甲鳥', type:'steel', type2:'flying', hp:270, tier:2, ability:{id:'sudden-death', name:'頑強', trigger:'onAttack', desc:'受到致命傷時，與對手同歸於盡'}, attacks:[{name:'蟲刃剪',dmg:85,cost:7,type:'bug',rider:'mega-charge',megaBoost:true,bonusEnergy:8,ignoreReflect:true},{name:'鐵頭',dmg:92,cost:7,type:'steel',ignoreReflect:true,megaBoost:true,bonusEnergy:8},{name:'啄',dmg:110,cost:8,type:'flying',megaBoost:true,bonusEnergy:8,bonusVsType:'psychic'},{name:'破魂強奪擊',dmg:60,cost:4,type:'fighting',rider:'energy-steal'}]},
  { mega:{spriteId:10306, type:'psychic', type2:'steel', ability:{id:'levitate', name:'飄浮', trigger:'onDefend', desc:'受到地面屬性攻擊時完全免疫，並且10%機率閃避對手攻擊'}}, id:358, name:'風鈴鈴', type:'psychic', hp:220, tier:1, ability:{id:'penetrate', name:'穿透', trigger:'onAttack', desc:'攻擊完後，會再造成70傷害'}, attacks:[{name:'高周波音',dmg:55,cost:3,type:'normal',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'大地吸血擊',dmg:62,cost:3,type:'ground',rider:'mega-charge'},{name:'破魂威壓擊',dmg:86,cost:7,type:'fighting',megaBoost:true,bonusEnergy:6,rider:'self-cure'},{name:'念力',dmg:105,cost:8,type:'psychic',selfHeal:0.25,ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10311, type:'fire', type2:'steel', ability:{id:'scorching-core', name:'熾熱核心', trigger:'onEnter', desc:'上場時，將對手燒傷，並棄掉對手兩張手牌'}}, id:485, name:'席多藍恩', type:'fire', type2:'steel', hp:285, tier:3, ability:{id:'flash-fire', name:'引火', trigger:'onDefend', desc:'受到火屬性攻擊時完全免疫，下次攻擊威力 +50'}, attacks:[{name:'金屬爪',dmg:93,cost:7,type:'steel',megaBoost:true,bonusEnergy:5},{name:'大字爆炎',dmg:100,cost:7,type:'fire',ignoreReflect:true,selfHeal:0.18},{name:'毒針',dmg:73,cost:5,type:'poison',rider:'mega-charge',status:{effect:'poison', chance:0.4},status2:{effect:'burn',chance:0.4}},{name:'寶石爆破',dmg:41,cost:1,type:'rock',rider:'type-draw',status:{effect:'confusion', chance:0.4},status2:{effect:'poison',chance:0.4}}]},
  { mega:{spriteId:10312, type:'dark', type2:null, ability:{id:'shadow-curse', name:'暗影', trigger:'onEnter', desc:'上場或是回合結束時，賦予對手寶可夢睡眠並棄掉對手一張手牌'}}, id:491, name:'達克萊伊', type:'dark', hp:310, tier:3, ability:{id:'nightmare-curse', name:'惡夢', trigger:'onEnter', desc:'上場或是回合結束時，賦予對手寶可夢睡眠，回合開始時，若對手寶可夢為睡眠狀態，HP -50'}, attacks:[{name:'泥巴射擊',dmg:85,cost:7,type:'ground',rider:'mega-charge',megaBoost:true,bonusEnergy:8},{name:'暗影球',dmg:68,cost:4,type:'ghost',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'夜騷動',dmg:110,cost:8,type:'dark',selfHeal:0.26,bonusVsType:'rock'},{name:'火焰牙',dmg:107,cost:8,type:'fire',ignoreReflect:true,status:{effect:'burn', chance:0.4},bonusVsType:'ice'}]},
  { mega:{spriteId:10286, type:'fire', type2:'fighting', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對手特性'}}, id:500, name:'炎武王', type:'fire', type2:'fighting', hp:300, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'幽靈之爪',dmg:64,cost:3,type:'ghost',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'近身戰',dmg:83,cost:6,type:'fighting',ignoreReflect:true,megaBoost:true,bonusEnergy:5},{name:'荒草吸血擊',dmg:102,cost:8,type:'grass',selfHeal:0.28,bonusVsType:'water',ignoreReflect:true},{name:'火花',dmg:109,cost:8,type:'fire',selfHeal:0.29,bonusVsType:'psychic'}]},
  { mega:{spriteId:10287, type:'ground', type2:'steel', ability:{id:'piercing-diamond', name:'貫穿之鑽', trigger:'onAttack', desc:'攻擊傷害 +40，攻擊不會被對手減傷'}}, id:530, name:'龍頭地鼠', type:'ground', type2:'steel', hp:300, tier:2, ability:{id:'sandstorm-stadium-dodge', name:'揚沙', trigger:'onEnter', desc:'上場時場地切換為沙塵暴，並且有20%機率完全閃避攻擊'}, attacks:[{name:'岩石滑落',dmg:58,cost:3,type:'rock',rider:'self-cure',megaBoost:true,bonusEnergy:7},{name:'泥巴射擊',dmg:77,cost:6,type:'ground',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'金屬爪',dmg:107,cost:8,type:'steel',selfHeal:0.18,bonusVsType:'bug',ignoreReflect:true},{name:'雪崩',dmg:103,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'ground'}]},
  { mega:{spriteId:10288, type:'bug', type2:'poison', ability:{id:'sturdy-half', name:'硬殼盔甲', trigger:'onDefend', desc:'HP >50% 時，受到會直接擊倒的攻擊會保留 1 HP'}}, id:545, name:'蜈蚣王', type:'bug', type2:'poison', hp:260, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'冰凍光束',dmg:50,cost:2,type:'ice',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'逆鱗威壓擊',dmg:85,cost:6,type:'dragon',rider:'self-cure'},{name:'毒液',dmg:81,cost:6,type:'poison',megaBoost:true,bonusEnergy:6},{name:'連續啃咬',dmg:100,cost:8,type:'bug',ignoreReflect:true,status:{effect:'freeze', chance:0.4},bonusVsType:'dragon',ignoreShield:true}]},
  { mega:{spriteId:10289, type:'dark', type2:'fighting', ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.5'}}, id:560, name:'頭巾混混', type:'dark', type2:'fighting', hp:240, tier:1, ability:{id:'endure-once', name:'淬鍊之心', trigger:'onAttack', desc:'受到致命傷害時，有一次機會以1HP存活'}, attacks:[{name:'灼熱吸能擊',dmg:77,cost:5,type:'fire',rider:'move-reflect',ignoreReflect:true},{name:'冰凍拳',dmg:73,cost:5,type:'ice',megaBoost:true,bonusEnergy:5,rider:'weaken'},{name:'近身戰',dmg:41,cost:1,type:'fighting',megaBoost:true,bonusEnergy:5,rider:'move-reflect'},{name:'惡意波動',dmg:99,cost:7,type:'dark',status:{effect:'freeze', chance:0.4},bonusVsType:'flying'}]},
  { mega:{spriteId:10290, type:'electric', type2:null, ability:{id:'elemental-purge', name:'電鰻升格', trigger:'onAttack', desc:'使用電屬性攻擊，棄掉對手兩張手牌'}}, id:604, name:'麻麻鰻魚王', type:'electric', hp:270, tier:2, ability:{id:'levitate', name:'飄浮', trigger:'onDefend', desc:'受到地面屬性攻擊時完全免疫，並且10%機率閃避對手攻擊'}, attacks:[{name:'咬碎',dmg:91,cost:7,type:'dark',rider:'mega-charge',megaBoost:true,bonusEnergy:7,ignoreReflect:true},{name:'電磁炮',dmg:110,cost:8,type:'electric',megaBoost:true,bonusEnergy:8,bonusVsType:'water'},{name:'毒牙',dmg:83,cost:7,type:'poison',megaBoost:true,bonusEnergy:8,rider:'card-steal'},{name:'破魂護甲擊',dmg:66,cost:4,type:'fighting',rider:'self-cure'}]},
  { mega:{spriteId:10292, type:'grass', type2:'fighting', ability:{id:'heavy-armor', name:'防彈', trigger:'onCard', desc:'使用道具卡，獲得減傷30 （可以疊加）'}}, id:652, name:'布里卡隆', type:'grass', type2:'fighting', hp:300, tier:2, ability:{id:'blaze-boost-pure', name:'茂盛', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，並且HP 低於 1/3 時，招式傷害額外 ×1.1'}, attacks:[{name:'吼叫',dmg:64,cost:4,type:'normal',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'磚塊',dmg:84,cost:7,type:'fighting',rider:'mega-charge',megaBoost:true,bonusEnergy:6},{name:'藤鞭',dmg:110,cost:8,type:'grass',selfHeal:0.19,ignoreReflect:true},{name:'燕返',dmg:110,cost:8,type:'flying',selfHeal:0.16,bonusVsType:'fighting',ignoreReflect:true}]},
  { mega:{spriteId:10293, type:'fire', type2:'psychic', ability:{id:'levitate', name:'飄浮', trigger:'onDefend', desc:'受到地面屬性攻擊時完全免疫，並且10%機率閃避對手攻擊'}}, id:655, name:'妖火紅狐', type:'fire', type2:'psychic', hp:260, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'攻擊附帶回復傷害50%HP的效果，HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'毒針',dmg:78,cost:6,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'未來雷霆',dmg:85,cost:6,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'暗影強奪擊',dmg:58,cost:3,type:'dark',rider:'mega-charge'},{name:'火花',dmg:100,cost:8,type:'fire',status:{effect:'confusion', chance:0.4},bonusVsType:'fairy',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10295, type:'fire', type2:'normal', ability:{id:'elemental-purge', name:'火鬃', trigger:'onAttack', desc:'使用火屬性攻擊時，棄掉對手兩張手牌'}}, id:668, name:'火炎獅', type:'fire', type2:'normal', hp:270, tier:2, ability:{id:'pressure', name:'緊張感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'突擊',dmg:87,cost:7,type:'normal',rider:'move-reflect',megaBoost:true,bonusEnergy:8},{name:'破魂吸血擊',dmg:83,cost:7,type:'fighting',ignoreReflect:true,rider:'life-drain'},{name:'大字爆炎',dmg:110,cost:8,type:'fire',megaBoost:true,bonusEnergy:8,bonusVsType:'ice'},{name:'惡意波動',dmg:62,cost:4,type:'dark',selfHeal:0.24,rider:'guard-up'}]},
  { mega:{spriteId:10296, type:'fairy', type2:null, ability:{id:'fairy-aura-field', name:'妖精領域', trigger:'onEnter', desc:'上場時場地切換為妖精結界原野，並回復8點能量'}}, id:670, name:'花葉蒂', type:'fairy', hp:200, tier:1, ability:{id:'heavy-armor', name:'花之守護', trigger:'onCard', desc:'使用道具卡時，獲得減傷30 （可以疊加）'}, attacks:[{name:'日光束',dmg:53,cost:2,type:'grass',rider:'self-cure',megaBoost:true,bonusEnergy:4},{name:'雷光威壓擊',dmg:49,cost:2,type:'electric',ignoreReflect:true,rider:'weaken'},{name:'突擊',dmg:69,cost:5,type:'normal',megaBoost:true,bonusEnergy:4,rider:'mega-charge'},{name:'魔法閃耀',dmg:99,cost:7,type:'fairy',status:{effect:'freeze', chance:0.4},bonusVsType:'rock'}]},
  { mega:{spriteId:10314, type:'psychic', type2:null, ability:{id:'trace', name:'複製', trigger:'onEnter', desc:'上場時獲得對手上回合使用過的道具卡（Mega 進化成這隻寶可夢也算這隻寶可夢上場）'}}, id:678, name:'超能妙喵', type:'psychic', hp:220, tier:1, ability:{id:'penetrate', name:'穿透', trigger:'onAttack', desc:'攻擊完後，會再造成70傷害'}, attacks:[{name:'暗黑爆破',dmg:52,cost:2,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'大地吸能擊',dmg:59,cost:2,type:'ground',rider:'self-cure'},{name:'火花',dmg:83,cost:6,type:'fire',megaBoost:true,bonusEnergy:7},{name:'念力',dmg:102,cost:8,type:'psychic',status:{effect:'sleep', chance:0.4},bonusVsType:'psychic',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10297, type:'dark', type2:'psychic', ability:{id:'contrary-mirror', name:'唱反調', trigger:'onAttack', desc:'對方增傷與減傷的效果反過來計算'}}, id:687, name:'烏賊王', type:'dark', type2:'psychic', hp:260, tier:2, ability:{id:'contrary-heart', name:'顛倒之心', trigger:'onAttack', desc:'雙方的卡牌效果都反過來'}, attacks:[{name:'大地波動',dmg:59,cost:2,type:'ground',ignoreReflect:true,megaBoost:true,bonusEnergy:6,rider:'type-draw'},{name:'精神強擊',dmg:78,cost:6,type:'psychic',megaBoost:true,bonusEnergy:6,rider:'energy-steal'},{name:'神速護甲擊',dmg:74,cost:6,type:'normal',rider:'type-draw'},{name:'惡意波動',dmg:105,cost:8,type:'dark',selfHeal:0.21,bonusVsType:'rock'}]},
  { mega:{spriteId:10298, type:'rock', type2:'fighting', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:689, name:'龜足巨鎧', type:'rock', type2:'water', hp:260, tier:2, ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}, attacks:[{name:'妖精吸能擊',dmg:80,cost:6,type:'fairy',rider:'mega-charge',megaBoost:true,bonusEnergy:6},{name:'鋼影強奪擊',dmg:64,cost:3,type:'steel',rider:'type-draw'},{name:'衝浪',dmg:83,cost:6,type:'water',megaBoost:true,bonusEnergy:6},{name:'岩石滑落',dmg:102,cost:8,type:'rock',ignoreReflect:true,selfHeal:0.21,bonusVsType:'fighting',ignoreShield:true}]},
  { mega:{spriteId:10299, type:'poison', type2:'dragon', ability:{id:'regenerator', name:'再生力', trigger:'passive', desc:'可以不用結束回合撤退'}}, id:691, name:'毒藻龍', type:'poison', type2:'dragon', hp:260, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'十字剪',dmg:84,cost:6,type:'bug',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'破魂吸血擊',dmg:57,cost:3,type:'fighting',rider:'energy-steal'},{name:'逆鱗護甲擊',dmg:87,cost:6,type:'dragon',megaBoost:true,bonusEnergy:7},{name:'惡意突刺',dmg:106,cost:8,type:'poison',ignoreReflect:true,selfHeal:0.15,bonusVsType:'grass',ignoreShield:true}]},
  { mega:{spriteId:10300, type:'fighting', type2:'flying', ability:{id:'shadow-tag-pierce', name:'無防守', trigger:'onAttack', desc:'攻擊不會被對手減傷，也不會對手閃避'}}, id:701, name:'摔角鷹人', type:'fighting', type2:'flying', hp:230, tier:1, ability:{id:'shadow-tag-pierce', name:'無防守', trigger:'onAttack', desc:'攻擊不會被對手減傷，也不會對手閃避'}, attacks:[{name:'惡意突刺',dmg:63,cost:4,type:'poison',rider:'mega-charge',megaBoost:true,bonusEnergy:8},{name:'大地威壓擊',dmg:59,cost:4,type:'ground',rider:'energy-steal'},{name:'疾風吸能擊',dmg:90,cost:7,type:'flying',megaBoost:true,bonusEnergy:8},{name:'空手劈',dmg:109,cost:8,type:'fighting',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10301, type:'dragon', type2:'ground', ability:{id:'terminus', name:'終結之地', trigger:'onEnter', desc:'上場時清掉場地效果，並且棄掉雙方手牌'}}, id:718, name:'基格爾德', type:'dragon', type2:'ground', hp:320, tier:3, ability:{id:'terminus', name:'終結之地', trigger:'onEnter', desc:'上場時清掉場地效果，並且棄掉雙方手牌'}, attacks:[{name:'咬碎',dmg:78,cost:6,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:8},{name:'電球',dmg:98,cost:8,type:'electric',status:{effect:'burn', chance:0.4},bonusVsType:'steel'},{name:'大地虹吸',dmg:105,cost:8,type:'ground',status:{effect:'paralysis', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'龍之波動',dmg:101,cost:8,type:'dragon',rider:'type-draw',selfHeal:0.21}]},
  { mega:{spriteId:10315, type:'fighting', type2:'ice', ability:{id:'dual-type-steel', name:'鐵拳', trigger:'onAttack', desc:'攻擊附帶鋼屬性傷害（計算傷害時，招式屬性以及鋼屬性攻擊擇優進行計算）'}}, id:740, name:'好勝毛蟹', type:'fighting', type2:'ice', hp:270, tier:2, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'受到致命傷害時，有30%機率以1HP存活'}, attacks:[{name:'岩崩吸能擊',dmg:88,cost:7,type:'rock',rider:'move-reflect',ignoreReflect:true},{name:'決勝衝擊',dmg:107,cost:8,type:'fighting',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'冰凍拳',dmg:91,cost:7,type:'ice',megaBoost:true,bonusEnergy:7,rider:'move-reflect'},{name:'夜襲',dmg:63,cost:4,type:'dark',selfHeal:0.29,rider:'guard-up'}]},
  { mega:{spriteId:10302, type:'normal', type2:'dragon', ability:{id:'guts', name:'崩潰', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:780, name:'老翁龍', type:'normal', type2:'dragon', hp:300, tier:2, ability:{id:'guts', name:'崩潰', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'月亮力量',dmg:86,cost:6,type:'fairy',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'龍之氣息',dmg:59,cost:3,type:'dragon',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'精神護甲擊',dmg:101,cost:8,type:'psychic',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting',ignoreReflect:true},{name:'吼叫',dmg:108,cost:8,type:'normal',selfHeal:0.28,bonusVsType:'dark'}]},
  { mega:{spriteId:10317, type:'steel', type2:'fairy', ability:{id:'huge-power', name:'心之力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:801, name:'瑪機雅娜', type:'steel', type2:'fairy', hp:310, tier:3, ability:{id:'huge-power', name:'心之力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}, attacks:[{name:'污泥炸彈',dmg:84,cost:6,type:'poison',ignoreReflect:true,megaBoost:true,bonusEnergy:8},{name:'魔法閃耀',dmg:57,cost:3,type:'fairy',rider:'energy-steal',megaBoost:true,bonusEnergy:8},{name:'鐵頭',dmg:110,cost:8,type:'steel',selfHeal:0.16,bonusVsType:'grass'},{name:'爆炸火焰',dmg:106,cost:8,type:'fire',selfHeal:0.18,bonusVsType:'bug',ignoreReflect:true}]},
  { mega:{spriteId:10319, type:'electric', type2:null, ability:{id:'charge', name:'蓄電', trigger:'onAttack', desc:'若上個回合我方寶可夢沒有攻擊，則這回合獲得傷害x2'}}, id:807, name:'捷拉奧拉', type:'electric', hp:310, tier:3, ability:{id:'charge', name:'蓄電', trigger:'onAttack', desc:'若上個回合我方寶可夢沒有攻擊，則這回合獲得傷害x2'}, attacks:[{name:'幽靈球',dmg:90,cost:7,type:'ghost',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'磚塊',dmg:62,cost:4,type:'fighting',rider:'mega-charge',megaBoost:true,bonusEnergy:8},{name:'冰霜吸血擊',dmg:105,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'ground',ignoreReflect:true},{name:'雷霆',dmg:110,cost:8,type:'electric',selfHeal:0.24,bonusVsType:'ghost'}]},
  { mega:{spriteId:10303, type:'fighting', type2:null, ability:{id:'guts', name:'不服輸', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:870, name:'列陣兵', type:'fighting', hp:230, tier:1, ability:{id:'sturdy', name:'戰鬥盔甲', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}, attacks:[{name:'妖精之風',dmg:60,cost:4,type:'fairy',rider:'self-cure',megaBoost:true,bonusEnergy:8},{name:'精神護甲擊',dmg:67,cost:4,type:'psychic',ignoreReflect:true,rider:'guard-up'},{name:'大地威壓擊',dmg:87,cost:7,type:'ground',megaBoost:true,bonusEnergy:8,rider:'energy-steal'},{name:'岩石碎裂',dmg:106,cost:8,type:'fighting',selfHeal:0.18,bonusVsType:'dark'}]},
  { mega:{spriteId:10320, type:'grass', type2:'fire', ability:{id:'spicy-burn', name:'辣椒噴霧', trigger:'onAttack', desc:'對手攻擊時，若對手使用非火屬性招式，對手被附加燒傷，再進行傷害計算'}}, id:952, name:'狠辣椒', type:'grass', type2:'fire', hp:220, tier:1, ability:{id:'insomnia', name:'不眠', trigger:'onAttack', desc:'不會陷入睡眠狀態，每回合30%機率額外抽一張道具卡'}, attacks:[{name:'電擊',dmg:59,cost:4,type:'electric',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'神速強奪擊',dmg:66,cost:4,type:'normal',rider:'mega-charge'},{name:'噴射火焰',dmg:86,cost:7,type:'fire',megaBoost:true,bonusEnergy:6},{name:'能量球',dmg:105,cost:8,type:'grass',status:{effect:'paralysis', chance:0.4},bonusVsType:'water',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10321, type:'rock', type2:'poison', ability:{id:'adaptability-major', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.4（原本 ×1.1）'}}, id:970, name:'晶光花', type:'rock', type2:'poison', hp:260, tier:2, ability:{id:'toxic-debris', name:'毒素碎片', trigger:'onAttack', desc:'受到對手攻擊後，對對手造成50點傷害，並讓對手中毒'}, attacks:[{name:'冰霜吸血擊',dmg:58,cost:3,type:'ice',rider:'self-cure',megaBoost:true,bonusEnergy:5,bonusVsType:'flying'},{name:'污泥炸彈',dmg:82,cost:7,type:'poison',megaBoost:true,bonusEnergy:5,rider:'card-steal'},{name:'幽冥吸血擊',dmg:89,cost:7,type:'ghost',rider:'mega-charge'},{name:'岩石滑落',dmg:108,cost:8,type:'rock',status:{effect:'freeze', chance:0.4},bonusVsType:'ground'}]},
  { mega:{spriteId:10322, type:'dragon', type2:'water', ability:{id:'legacy-boost', name:'指揮', trigger:'onDefend', desc:'受到攻擊後，下個我方回合抽取兩張道具卡，寶可夢招式傷害+50'}}, id:978, name:'米立龍', type:'dragon', type2:'water', hp:210, tier:1, ability:{id:'legacy-boost', name:'指揮', trigger:'onDefend', desc:'受到攻擊後，下個我方回合抽取兩張道具卡，寶可夢招式傷害+50'}, attacks:[{name:'雪崩',dmg:53,cost:2,type:'ice',rider:'energy-steal',megaBoost:true,bonusEnergy:5},{name:'龍之脈動',dmg:49,cost:2,type:'dragon',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'劇毒威壓擊',dmg:69,cost:5,type:'poison',rider:'weaken'},{name:'水槍',dmg:99,cost:7,type:'water',status:{effect:'freeze', chance:0.4},bonusVsType:'ground',ignoreReflect:true}]},
  { mega:{spriteId:10325, type:'dragon', type2:'ice', ability:{id:'flash-fire-major', name:'熱交換', trigger:'onDefend', desc:'受到火屬性攻擊時完全免疫，並且下次攻擊傷害 +40'}}, id:998, name:'戟脊龍', type:'dragon', type2:'ice', hp:245, tier:3, ability:{id:'flash-fire-major', name:'熱交換', trigger:'onDefend', desc:'受到火屬性攻擊時完全免疫，並且下次攻擊傷害 +40'}, attacks:[{name:'寶石爆破',dmg:45,cost:1,type:'rock',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6,rider:'weaken'},{name:'龍之波動',dmg:69,cost:5,type:'dragon',rider:'self-cure',status:{effect:'confusion', chance:0.4},status2:{effect:'sleep',chance:0.4}},{name:'冰耳光',dmg:99,cost:7,type:'ice',selfHeal:0.23,bonusVsType:'bug'},{name:'蟲毒吸能擊',dmg:72,cost:5,type:'bug',selfHeal:0.17,rider:'weaken'}]},
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
  // 2026-07-29新增：盧恩啟示，應使用者要求「這張卡片出現的機率與屬性卡一樣」，同樣列6次
  {id:'rune-revelation', name:'盧恩啟示', cat:'item',   desc:'下次攻擊無視對方反彈鏡；並免疫下一次搏命效果（若對手使用搏命，只有對手的寶可夢會倒下）'},
  {id:'rune-revelation', name:'盧恩啟示', cat:'item',   desc:'下次攻擊無視對方反彈鏡；並免疫下一次搏命效果（若對手使用搏命，只有對手的寶可夢會倒下）'},
  {id:'rune-revelation', name:'盧恩啟示', cat:'item',   desc:'下次攻擊無視對方反彈鏡；並免疫下一次搏命效果（若對手使用搏命，只有對手的寶可夢會倒下）'},
  {id:'rune-revelation', name:'盧恩啟示', cat:'item',   desc:'下次攻擊無視對方反彈鏡；並免疫下一次搏命效果（若對手使用搏命，只有對手的寶可夢會倒下）'},
  {id:'rune-revelation', name:'盧恩啟示', cat:'item',   desc:'下次攻擊無視對方反彈鏡；並免疫下一次搏命效果（若對手使用搏命，只有對手的寶可夢會倒下）'},
  {id:'rune-revelation', name:'盧恩啟示', cat:'item',   desc:'下次攻擊無視對方反彈鏡；並免疫下一次搏命效果（若對手使用搏命，只有對手的寶可夢會倒下）'},
  {id:'retreat-vest', name:'撤退背心', cat:'item',      desc:'下次換場不會結束回合'},
  {id:'confuse-potion', name:'混亂藥', cat:'item',      type:'psychic', weight:10, desc:'讓對手上場寶可夢陷入混亂'},
  {id:'absolute-zero', name:'絕對零度', cat:'item',     type:'ice', weight:10,     desc:'讓對手上場寶可夢陷入結凍'},
  {id:'energy-patch-l', name:'能量補丁（大）', cat:'item', desc:'回復 8 點能量'},
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
  {id:'night-raid',    name:'夜襲',     cat:'item', type:'dark', weight:10, energyCost:5, desc:'消耗 5 點能量，隨機搶奪對手 2 張手牌'},
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
  {id:'lightning-dash', name:'電光石火',   cat:'item', type:'electric', weight:10, desc:'下次電屬性寶可夢或電屬性招式攻擊不消耗能量'},
  {id:'leech-seed',     name:'寄生種子',   cat:'item', type:'grass', weight:10,    desc:'接下來 3 回合，每回合開始吸取對方 3 點能量轉為自己能量'},
  {id:'mind-focus',     name:'心靈感應',   cat:'item', type:'psychic', weight:10,  desc:'下次攻擊的異常狀態機率視為 100%，並讓對手陷入 1 回合睡眠'},
  {id:'breakthrough',   name:'直搗黃龍',   cat:'item', type:'fighting', weight:10, desc:'下次攻擊威力 +40，且無視對方的「受傷減少」效果'},
  {id:'wraith-curse',   name:'亡靈詛咒',   cat:'item', type:'ghost', weight:10,    desc:'封印對手 Mega 進化 2 回合，並讓對方損失 5 點能量'},
  {id:'dragon-might',   name:'龍神顯現',   cat:'item', type:'dragon', weight:10,   desc:'自身損失 25% 最大HP，下次攻擊威力 ×1.5'},
  {id:'steel-fortress', name:'鋼鐵壁壘',   cat:'item', type:'steel', weight:10,    desc:'下次受到攻擊傷害減少 100'},
  {id:'frost-armor',    name:'冰凍護甲',   cat:'item', type:'ice', weight:10,      desc:'下次受到攻擊傷害減少 60；若對方該次攻擊為冰屬性則完全無效'},
  {id:'quick-thinking', name:'隨機應變',   cat:'item', type:'normal', weight:10,   desc:'立即抽 2 張手牌'},
  {id:'shadow-lockdown',name:'暗影封鎖',   cat:'item', type:'dark', weight:10,     desc:'封印對手 Mega 進化 2 回合，並讓對方隨機棄 1 張手牌'},
  {id:'gale-dodge',     name:'疾風迴避',   cat:'item', type:'flying', weight:10,   desc:'下次受到攻擊有 50% 機率完全迴避'},
  {id:'tectonic-shift', name:'地殼變動',   cat:'item', type:'rock', weight:10,     desc:'立即清除目前的競技場效果'},
  {id:'fairy-barrier',  name:'妖精結界',   cat:'item', type:'fairy', weight:10,    desc:'接下來 2 回合，我方上場寶可夢免疫異常狀態；若為妖精屬性額外回復 5% 最大HP'},
  {id:'toxic-pact',     name:'劇毒契約',   cat:'item', type:'poison', weight:10,   desc:'讓對方陷入中毒，並讓對方損失 10 點能量'},
  {id:'swarm-feast',    name:'蟲群啃食',   cat:'item', type:'bug', weight:10,      desc:'讓對方損失 8 點能量，其中 4 點轉給自己'},
  // ── 支援者牌屬性分類新卡 第二批（每種屬性再+2張，延續同一套屬性→機制對照表）──
  {id:'fire-fury',        name:'業火燎原',   cat:'item', type:'fire',     weight:10, desc:'若對手已有異常狀態，下次攻擊威力 +70；否則 +25'},
  {id:'fire-resolve',     name:'灰燼決意',   cat:'item', type:'fire',     weight:10, desc:'下次攻擊威力 ×1.3，自身損失 60 HP；若非火屬性寶可夢額外陷入燒傷'},
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
  {id:'dragon-fang',      name:'逆鱗',       cat:'item', type:'dragon',   weight:10, desc:'下次攻擊威力 +90，自身損失 5 點能量'},
  {id:'dragon-cleanse',   name:'龍息滌蕩',   cat:'item', type:'dragon',   weight:10, desc:'解除自身異常狀態，並回復 5 HP'},
  {id:'steel-resolve',    name:'鋼鐵意志',   cat:'item', type:'steel',    weight:10, desc:'下次受到攻擊傷害減少 50，並立即回復 5 點能量'},
  {id:'steel-flash',      name:'鎂光反射',   cat:'item', type:'steel',    weight:10, desc:'下次受到攻擊傷害減少 40，且對手下次施放的負面效果會反彈回對手自己身上'},
  {id:'ice-howl',         name:'冰霜咆哮',   cat:'item', type:'ice',      weight:10, desc:'下次冰屬性攻擊威力 ×1.2，並額外有 40% 機率附加結凍'},
  {id:'ice-barrier',      name:'極寒屏障',   cat:'item', type:'ice',      weight:10, desc:'下次受到攻擊傷害減少 40，接下來 1 回合免疫異常狀態'},
  {id:'normal-allout',    name:'全力以赴',   cat:'item', type:'normal',   weight:10, desc:'下次攻擊威力 +35，一般屬性寶可夢或一般屬性招式攻擊不消耗能量'},
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
  // ── stadium ── 2026-08-13全面重新設計（見battle-logic skill的「場地卡24張全面重新設計」章節）
  {id:'stadium-training',      name:'訓練場',     cat:'stadium', desc:'場上所有技能威力 +25（雙方）；回合結束時，該回合玩家額外抽取一張支援者卡'},
  {id:'stadium-spring',        name:'地熱溫泉',   cat:'stadium', desc:'每回合結束，該回合玩家的寶可夢回復 70HP，並且可以抽取一張支援者卡牌'},
  {id:'stadium-reversal',      name:'逆轉鬥技場', cat:'stadium', desc:'若寶可夢HP 低於 50% 時，攻擊威力 +30，並且回合結束時，回復150HP'},
  {id:'stadium-invert',        name:'反轉世界',   cat:'stadium', desc:'場上屬性相剋完全反轉（克制↔抵抗，免疫→克制×1.2）；發動時，雙方手牌互換'},
  {id:'stadium-dragon-valley', name:'龍之谷',     cat:'stadium', type:'dragon', weight:10, desc:'龍屬性寶可夢的弱點消失，攻擊不會被減免或無效，並且招式消耗能量 -5'},
  {id:'stadium-evil-forest',   name:'邪惡森林',   cat:'stadium', type:'grass', weight:10, desc:'草屬性的寶可夢的招式一律視為剋制對手（效果拉滿 ×1.2）；每回合結束，我方草屬性寶可夢回復 70 HP'},
  {id:'stadium-mega-prism',    name:'Mega 稜鏡塔', cat:'stadium', desc:'雙方每個自己的回合開始時，獲得 16 點 Mega 能量；可 Mega 進化或已經 Mega 進化的寶可夢，受到的攻擊傷害 ×0.6'},
  {id:'stadium-spikes',        name:'尖峰陷阱',   cat:'stadium', desc:'寶可夢上場時，受到100傷害（雙方對等），發動時，對手棄掉2張手牌'},
  {id:'stadium-toxic-field',   name:'劇毒領域',   cat:'stadium', type:'poison', weight:10, desc:'寶可夢上場時，陷入中毒（雙方對等），此場地下中毒不能被解除，中毒傷害 ×2；毒系寶可夢有 20% 機率完全閃避攻擊（不疊加）'},
  {id:'stadium-colosseum',     name:'羅馬鬥技場', cat:'stadium', type:'fighting', weight:10, desc:'格鬥屬性攻擊不再被幽靈屬性完全免疫；格鬥屬性的招式會連續發動兩次，第二次傷害 ×0.4（若第一次就打倒對手，第二次改攻擊新上場的寶可夢）'},
  {id:'stadium-mystic-space',  name:'魔幻空間',   cat:'stadium', type:'psychic', weight:10, desc:'超能力屬性寶可夢受到的傷害 -50；超屬性的招式會連續發動兩次，第二次傷害 ×0.4（若第一次就打倒對手，第二次改攻擊新上場的寶可夢）；發動時或回合結束時，若我方場上寶可夢是超屬性寶可夢，可搶奪對方一張卡牌'},
  {id:'stadium-lava',          name:'熔岩火山',   cat:'stadium', type:'fire', weight:10, desc:'火屬性的招式傷害 +50；水屬性招式傷害 ×0.3；火屬性的寶可夢造成的攻擊會讓對手燒傷；此場地下燒傷不能被解除，燒傷的寶可夢傷害x0.1'},
  {id:'stadium-ocean',         name:'海洋世界',   cat:'stadium', type:'water', weight:10, desc:'水屬性招式消耗能量 -2；水屬性寶可夢招式造成的傷害+20；回合結束時回復30HP'},
  {id:'stadium-shrine',        name:'莊嚴神社',   cat:'stadium', type:'normal', weight:10, desc:'一般屬性招式一律視為剋制對手（效果拉滿 ×1.2）；一般屬性寶可夢受到的攻擊傷害 -50，回合結束時，一般屬性寶可夢回復70hp'},
  // ── stadium：屬性分類新卡 ──
  {id:'stadium-sandstorm',   name:'沙塵暴',   cat:'stadium', type:'ground', weight:10, desc:'非地面／岩石/鋼屬性寶可夢，雙方回合結束損失50HP，開始時損失20HP，地面/岩石屬性寶可夢有70%機率完全閃避攻擊(不疊加）'},
  {id:'stadium-rock-field',  name:'岩石地帶', cat:'stadium', type:'rock', weight:10, desc:'岩石／地面寶可夢，攻擊造成的傷害 +50，不會受到屬性剋制（弱點消除），並且受到的傷害-20'},
  // ── 競技場牌：8種先前沒有專屬場地的屬性（2026-07-23新增，各自搭配一個獨特玩法，不只是傷害數值）──
  {id:'stadium-electric-storm', name:'雷雲庇護所', cat:'stadium', type:'electric', weight:10, desc:'電屬性招式傷害 +30；電屬性寶可夢招式消耗能量 -2；有麻痺狀態的寶可夢100% 無法攻擊成功'},
  {id:'stadium-ice-tundra',     name:'永凍冰原',   cat:'stadium', type:'ice',      weight:10, desc:'冰屬性的招式傷害 +30，受到傷害-50；回合結束時，若對手寶可夢為非冰屬性寶可夢則被結凍'},
  {id:'stadium-dark-curse',     name:'暗夜詛咒領域', cat:'stadium', type:'dark',   weight:10, desc:'惡屬性招式傷害 ×1.2；此場地啟用中，雙方的所有恢復效果全部失效。若場上為惡屬性寶可夢，回合結束時，棄掉對手1張手牌'},
  {id:'stadium-steel-fortress', name:'鋼鐵堡壘',   cat:'stadium', type:'steel',    weight:10, desc:'鋼屬性的招式傷害 +30；鋼屬性寶可夢受到的傷害-50'},
  {id:'stadium-flying-wind',    name:'疾風之翼',   cat:'stadium', type:'flying',   weight:10, desc:'飛行屬性招式傷害 ×1.2；飛行屬性寶可夢有 50% 機率完全迴避攻擊（不疊加），若備戰區有飛行屬性寶可夢，場上寶可夢撤退回合不會結束（不能抽支援者卡）'},
  {id:'stadium-bug-hive',       name:'蟲群巢穴',   cat:'stadium', type:'bug',      weight:10, desc:'蟲屬性的招式傷害 +30；蟲屬性的寶可夢有 50% 機率完全閃避攻擊（不疊加）；此場地下，抽牌／搶奪對方手牌類卡片不受每回合1次限制'},
  {id:'stadium-ghost-curse',    name:'亡靈墓園',   cat:'stadium', type:'ghost',    weight:10, desc:'幽靈屬性寶可夢的招式消耗能量 -4，幽靈屬性的招式會連續發動兩次，第二次傷害 ×0.4（若第一次就打倒對手，第二次改攻擊新上場的寶可夢）；此場地下，異常狀態無法被解除'},
  {id:'stadium-fairy-ward',     name:'妖精結界原野', cat:'stadium', type:'fairy',  weight:10, desc:'妖精屬性的寶可夢招式傷害 +30；回合開始與此卡發動時，妖精寶可夢解除負面狀態；回合結束時，對方寶可夢獲得混亂'},
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
  'kaobei':             { name: '靠杯',          image: '/badges/kaobei-01.gif' },
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
  // 單人模式冠軍獎盃——不能買，只能靠打贏「冠軍挑戰模式」三關核發（見 POST /api/pet/claim-champion-trophy），
  // notForSale讓/api/pet/buy擋掉直接購買；price:0是雙重防呆，萬一notForSale漏檔也不會被免費買到還扣負數。
  // 這筆仍要留在SHOP_ITEMS裡（不能整個抽掉/從/api/shop濾掉）——tamagotchi.html渲染「已擁有的裝飾」
  // 一樣是查shopItems[itemId]拿icon/name，濾掉這筆會讓已核發的獎盃在房間裡直接不見。
  'trophy-champion': { name: '單人模式冠軍獎盃', price: 0, icon: '🏆', iconUrl: '/decor/trophy-champion.gif', category: 'decor', notForSale: true },
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

/* 彈弓小遊戲——拉弓瞄準飛行中的鳥類，命中後累計命中次數，次數集滿才真的捕捉進「鳥類收藏」
   （獨立於隊伍/戰鬥，跟釣魚的pet_fish同一套模式，見BIRD_TYPES）。跟地面捕捉（/api/pet/catch/*）
   共用「命中判定分兩層」的精神：client端拖曳拋物線物理+畫面碰撞判定「有沒有命中」（技巧層，
   client決定），每次命中都呼叫這裡的/hit端點由伺服器扣減命中次數（伺服器端權威計數，不信任
   client回報「這是第幾次命中」）——避免client直接偽造「已經打滿次數」就能無條件捕捉稀有鳥類。
   2026-07-26 改版：原本命中後還要再擲一次SLINGSHOT_HIT_RATE捕捉機率，現在改成「命中次數集滿
   （依BIRD_TYPES[birdType].hits，一般鳥1~3次、Mega暴飛龍5次）就一定捕捉成功」——命中次數本身
   已經是難度/運氣的呈現方式，疊加一層機率反而讓「明明打中了却抓不到」的挫折感沒有意義。
   跟地面捕捉刻意不同的地方：沒有選球機制，遭遇用固定30秒真實倒數（不像地面捕捉每次沒抓到就
   展延過期時間）——時間到鳥就真的飛走，沒有退款。 */
const SLINGSHOT_ENCOUNTER_COST = 80;
// 2026-07-27新增：除了80金幣，也可以改付5顆一般精靈球——玩家在client端的選擇畫面二選一，
// 這裡用paymentMethod區分兩條扣款路徑，跟地面捕捉「一定要選球」不同，彈弓本身沒有選球機制，
// 這裡的球只是「代替金幣的付費方式」，不影響命中次數等遭遇本身的邏輯。
const SLINGSHOT_BALL_COST = 5;
// 2026-07-26應使用者要求拿掉「主動放棄退款」功能——不論是提早關窗還是時間自然到期，
// 這次彈弓的花費一律不退，跟地面捕捉的giveup機制不同，不用另外留一個常數/端點。
const SLINGSHOT_TTL_MS = 30 * 1000; // 30秒真實倒數，不像地面捕捉的activeEncounters會展延
// 命中但還沒集滿次數時，小機率讓鳥直接飛走結束遭遇（跟地面捕捉的FIERCE_RESISTANCE_CHANCE
// 共用同一個值，維持一點真實感的緊張感，不是每次命中都保證能繼續打）
const activeSlingshotEncounters = new Map(); // userId -> { birdType, name, hits, hitsRemaining, expiresAt }

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

/* 彈弓小遊戲的鳥類收藏——跟FISH_TYPES同一套registry-driven設計（weight抽獎、獨立於戰鬥用
   POKEMON陣列，只借speciesId拿PokeAPI sprite），但這裡沒有「none」失手項目，因為彈弓的
   命中/落空已經在client端物理判定過了，遭遇一旦真的命中就一定屬於某一種鳥，不會像釣魚
   那樣連「有沒有咬餌」都要用一次weight抽獎決定。
   10隻一般鳥（先隨機挑，之後可以再調整名單）+ 1隻稀有的「Mega暴飛龍」（見POKEMON裡
   id:373的mega欄位，spriteId:10089）。weight用19×10+10=200，Mega暴飛龍抽中機率剛好10/200=5%。
   hits＝需要命中幾次才能捕捉成功（依寶可夢設定，Mega暴飛龍要5次，其餘一律2~3次——原本有3隻
   設成hits:1，2026-07-26應使用者回報「打到血量就歸零，跟預期不一樣」拿掉，改成最少2次，
   確保血條真的會看到「還沒空」的中間狀態，不要有一擊必中的鳥）。
   sellPrice——鳥籠比照魚缸有賣出機制（2026-07-26應使用者要求補上），依hits訂價（打越多下越貴）。
   showdownName——2026-07-26修正「鋼鎧鴉/Mega暴飛龍等等都不會動」的回報：PokeAPI的Gen5 B/W
   動圖只涵蓋到第五世代，鋼鎧鴉(Gen8)/烈箭鷹/摔角鷹人(Gen6)/Mega表單完全沒有這份動圖，
   一律靜態退回。改用Pokémon Showdown的動態sprite（play.pokemonshowdown.com/sprites/ani/
   {name}.gif，這11隻全部都有curl驗證過，含Mega表單），前端optionsUrl見bird相關render函式。 */
const BIRD_TYPES = {
  'pidgeot':     { name: '大比鳥',   speciesId: 18,  weight: 19, hits: 2, sellPrice: 20,  showdownName: 'pidgeot' },
  'staraptor':   { name: '姆克鷹',   speciesId: 398, weight: 19, hits: 2, sellPrice: 25,  showdownName: 'staraptor' },
  'corviknight': { name: '鋼鎧鴉',   speciesId: 823, weight: 19, hits: 2, sellPrice: 25,  showdownName: 'corviknight' },
  'honchkrow':   { name: '烏鴉頭頭', speciesId: 430, weight: 19, hits: 2, sellPrice: 25,  showdownName: 'honchkrow' },
  'talonflame':  { name: '烈箭鷹',   speciesId: 663, weight: 19, hits: 2, sellPrice: 25,  showdownName: 'talonflame' },
  'skarmory':    { name: '盔甲鳥',   speciesId: 227, weight: 19, hits: 3, sellPrice: 40,  showdownName: 'skarmory' },
  'hawlucha':    { name: '摔角鷹人', speciesId: 701, weight: 19, hits: 2, sellPrice: 20,  showdownName: 'hawlucha' },
  'fearow':      { name: '大嘴雀',   speciesId: 22,  weight: 19, hits: 2, sellPrice: 20,  showdownName: 'fearow' },
  'swellow':     { name: '大王燕',   speciesId: 277, weight: 19, hits: 2, sellPrice: 25,  showdownName: 'swellow' },
  'dodrio':      { name: '多多利',   speciesId: 85,  weight: 19, hits: 3, sellPrice: 40,  showdownName: 'dodrio' },
  'mega-salamence': { name: 'Mega暴飛龍', speciesId: 10089, weight: 10, hits: 5, rare: true, sellPrice: 300, showdownName: 'salamence-mega' },
};
function rollBird() {
  const entries = Object.entries(BIRD_TYPES);
  const total = entries.reduce((s, [, b]) => s + b.weight, 0); // 200
  let r = Math.random() * total;
  for (const [id, b] of entries) {
    if (r < b.weight) return id;
    r -= b.weight;
  }
  return entries[entries.length - 1][0];
}

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
// 第二隻寵物的價格（2026-08-10新增，見/api/pet/buy-second）
const SECOND_PET_PRICE = 5000;

/* ═══════════════════════════════════════════
   GAME LOGIC  (synchronous server-side)
═══════════════════════════════════════════ */
function clonePoke(p) {
  return { ...p, attacks: p.attacks.map(a => ({...a})), cur: p.hp, status: null,
    megaEvolved: p.mega ? false : undefined };
}

function effectiveCostSrv(atk, opponentPoke, G, buff, attackerPoke, opRole, attackerRole) {
  // 電光石火／全力以赴：2026-07-28應使用者要求，原本「這次攻擊必定免費」改成「攻擊的寶可夢
  // 或招式本身符合指定屬性才免費」——buff.costFreeType記著是哪個屬性（'electric'/'normal'）
  if (buff?.costFreeType && attackerPoke &&
      (attackerPoke.type === buff.costFreeType || attackerPoke.type2 === buff.costFreeType || atk.type === buff.costFreeType)) return 0;
  let cost = atk.cost;
  // 2026-07-31應使用者要求：mega進化後攻擊消耗的能量要比不能mega的寶可夢更低，固定8折
  if (attackerPoke?.megaEvolved) cost = Math.floor(cost * 0.8);
  // 2026-08-13場地卡重新設計：以下4張場地卡的能量折扣統一改成「固定 -N」，取代舊版各自不同的
  // 倍率折扣寫法（海洋世界原本是×0.3），下限夾在0，避免變成負數消耗
  if (G?.activeStadium?.id === 'stadium-ocean' && atk.type === 'water') cost = Math.max(0, cost - 2);
  if (G?.activeStadium?.id === 'stadium-dragon-valley' && atk.type === 'dragon') cost = Math.max(0, cost - 5);
  if (G?.activeStadium?.id === 'stadium-electric-storm' && atk.type === 'electric') cost = Math.max(0, cost - 2);
  if (G?.activeStadium?.id === 'stadium-ghost-curse' && atk.type === 'ghost') cost = Math.max(0, cost - 4);
  if (buff?.costHalved) cost = Math.floor(cost / 2);
  // 漩渦威壓（洛奇亞專屬）：只要牠在場上防守，對手攻擊消耗的能量持續 +3（封印特性時視為不存在）
  if (opponentPoke?.ability?.id === 'vortex-pressure' && opRole && !isAbilitySealedSrv(opRole, G)) cost += 3;
  // 飛毛腿（quick-feet，2026-08-15新增）：招式能量消耗-5
  if (attackerPoke?.ability?.id === 'quick-feet' && attackerRole && !isAbilitySealedSrv(attackerRole, G)) cost = Math.max(0, cost - 5);
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
  // 邪惡森林：2026-08-13重新設計——原本只對5種「原本克制草屬性」的對手生效，新版是「草屬性的
  // 招式一律視為剋制對手」，跟下面莊嚴神社的一般屬性同一種「無條件強制m=2」寫法，不再限定對手屬性
  if (G?.activeStadium?.id === 'stadium-evil-forest' && eAtk === 'grass') {
    m = 2;
  }
  if (G?.activeStadium?.id === 'stadium-colosseum') {
    if (eAtk === 'fighting' && (defType === 'ghost' || defType2 === 'ghost') && m === 0) m = 1;
  }
  // 岩石地帶：2026-08-13重新設計，弱點消除的對象從「岩石／地面／鋼」縮小成「岩石／地面」
  // （鋼屬性另有自己專屬的鋼鐵堡壘場地卡，不再共用這張）
  if (G?.activeStadium?.id === 'stadium-rock-field') {
    if ((['rock','ground'].includes(defType) || ['rock','ground'].includes(defType2)) && m > 1) m = 1;
  }
  // 2026-07-24應使用者要求「場地卡下修」，把m=5（compressMult=1.8）調回m=2（compressMult=1.2）
  if (G?.activeStadium?.id === 'stadium-shrine' && eAtk === 'normal') {
    m = 2;
  }
  return compressMult(m);
}

function dealHand(n) {
  return [...TRAINERS].sort(() => Math.random() - 0.5).slice(0, n);
}

// 2026-07-23應使用者要求：待機／換人／詭計等「隨機抽1張支援者卡」的地方盡量避開手牌裡已經有的
function pickSupporterAvoidingDupes(hand) {
  const all = TRAINERS.filter(c => c.cat === 'supporter');
  const avail = all.filter(c => !hand.some(h => h.id === c.id));
  const pool = avail.length ? avail : all;
  return pool[Math.floor(Math.random() * pool.length)];
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

// 找出poke的.status/.status2兩格裡，哪一格是指定type——2026-07-27改版後兩格都可以是任何
// 異常狀態，不再限制副格只能中毒/燒傷，所以判定阻擋攻擊的邏輯要能對「隨便哪一格」生效
function findStatusSlot(poke, type) {
  if (poke.status?.type === type) return 'status';
  if (poke.status2?.type === type) return 'status2';
  return null;
}

// Processes status before an attack. Mutates poke.
// Returns { skipped, died }
function handleStatus(poke, log, atkType, G) {
  // 阻擋型狀態的優先順序：睡眠/結凍是絕對阻擋，麻痺是機率阻擋，混亂是機率打自己——
  // 兩格都可能命中其中之一時，依此順序只解決第一個命中的，不會同時判定兩次
  // 2026-07-30應使用者回報「結凍最後一回合，圖示還在效果卻沒了」修正：睡眠/結凍/混亂原本都是
  // 先扣turnsLeft、再用扣減後的值判斷「這回合還要不要擋」，等於turnsLeft設2實際只會擋1回合就
  // 提前解除。改成用扣減前的值決定「這回合仍在效果內」，扣減後才視情況清除狀態物件，讓設定
  // N回合就是真的擋滿N回合。
  const sleepSlot = findStatusSlot(poke, 'sleep');
  if (sleepSlot) {
    const st = poke[sleepSlot];
    log.push({ text: `${poke.name} 睡著了，無法行動！（剩 ${st.turnsLeft} 回合）`, cls: 'special' });
    st.turnsLeft--;
    if (st.turnsLeft <= 0) poke[sleepSlot] = null; // 用完最後一回合的睡眠額度，下次行動才會真的清醒
    return { skipped: true, died: false };
  }

  const freezeSlot = findStatusSlot(poke, 'freeze');
  if (freezeSlot) {
    const st = poke[freezeSlot];
    if (atkType === 'fire') {
      poke[freezeSlot] = null;
      log.push({ text: `${poke.name} 使出火屬性招式，解凍了！`, cls: 'special' });
      return { skipped: false, died: false };
    }
    log.push({ text: `${poke.name} 被冰凍住了，無法行動！（剩 ${st.turnsLeft} 回合）`, cls: 'special' });
    st.turnsLeft--;
    if (st.turnsLeft <= 0) poke[freezeSlot] = null; // 用完最後一回合的結凍額度，下次行動才會真的解凍
    return { skipped: true, died: false };
  }

  const paralysisSlot = findStatusSlot(poke, 'paralysis');
  if (paralysisSlot) {
    // 雷雲庇護所：2026-08-13新增，此場地下麻痺的寶可夢100%無法攻擊成功（原本是50%機率）
    const paralysisSkipChance = G?.activeStadium?.id === 'stadium-electric-storm' ? 1 : 0.5;
    if (Math.random() < paralysisSkipChance) {
      log.push({ text: `${poke.name} 因麻痺無法行動！`, cls: 'special' });
      return { skipped: true, died: false };
    }
    // 麻痺沒觸發阻擋——繼續往下檢查混亂（真實系列作也是麻痺沒擋下才輪到混亂判定）
  }

  const confusionSlot = findStatusSlot(poke, 'confusion');
  if (confusionSlot) {
    const st = poke[confusionSlot];
    st.turnsLeft--;
    if (st.turnsLeft <= 0) poke[confusionSlot] = null; // 這回合是混亂的最後一次判定，判定完才解除
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
// status2（副格）只會是中毒/燒傷，依序處理.status再處理.status2——任一格導致陣亡（cur<=0）
// 就不再處理下一格，呼叫端還是只要檢查一次poke.cur就知道有沒有陣亡
function applyEndOfTurnStatusSrv(poke, log, G, role) {
  const ability = (role && isAbilitySealedSrv(role, G)) ? null : poke.ability; // 封印特性中視為沒有特性
  for (const st of [poke.status, poke.status2]) {
    if (poke.cur <= 0) return;
    if (!st || (st.type !== 'poison' && st.type !== 'burn')) continue;
    if (ability?.id === 'magic-guard') {
      log.push({ text: `${poke.name} 的魔法防守抵消了${st.type === 'poison' ? '中毒' : '燒傷'}傷害！`, cls: 'special' });
      continue;
    }
    if (st.type === 'poison' && ability?.id === 'poison-heal' && !(role && isHealSealedSrv(role, G))) {
      // 2026-08-14應使用者要求：回復量從1/8最大HP改成固定70，跟pokemon_battle.html同步
      const heal = Math.min(70, poke.hp - poke.cur);
      poke.cur = Math.min(poke.hp, poke.cur + heal);
      log.push({ text: `${poke.name} 的毒療發動，中毒回復了 ${heal} 點HP！`, cls: 'special' });
      continue;
    }
    // 劇毒領域場地啟用時，中毒傷害×2（2026-07-22場地卡全面加強）
    const toxicFieldActive = G?.activeStadium?.id === 'stadium-toxic-field';
    const dmg = st.type === 'poison' ? Math.max(1, Math.floor(poke.hp / 8 * (toxicFieldActive ? 2 : 1))) : Math.max(1, Math.floor(poke.hp / 16));
    const label = st.type === 'poison' ? '中毒' : '燒傷';
    poke.cur = Math.max(0, poke.cur - dmg);
    log.push({ text: `${poke.name} 因${label}損失了 ${dmg} HP！`, cls: 'special' });
  }
}

// Ticks the OPPONENT's (op's) own lingering poison/burn at the genuine end of role's turn —
// mainline Pokémon Checkup timing checks BOTH actives after every turn, not just whoever's turn
// it was (2026-08-07 fix; previously a side's poison/burn only ticked once every other turn,
// on its own turn's end, instead of every turn). Call this from every real turn-ending call
// site (attack/standby — see their handlers below) in addition to the existing role-side tick.
// Returns true if op's active died from this tick — the caller must NOT also call
// drawForRole/G.round++ for op in that case; either queue op behind an already-pending KO
// switch (if role itself also needs one this turn) or set G.pendingKOSwitch/G.turn = op
// directly and let the ko_switch handler's own draw-once-resolved logic take over.
function tickOpponentStatusAtTurnEndSrv(G, log, op) {
  const opActive = G[`${op}Deck`][G[`${op}Idx`]];
  if (opActive.cur > 0) applyEndOfTurnStatusSrv(opActive, log, G, op);
  tryHealingRainbowRevive(opActive, log);
  return opActive.cur <= 0;
}

// Decrements sleep/freeze/confusion duration on a turn where the Pokémon didn't attempt to
// attack (standby) — no attack-blocking or confusion self-hit here, those only apply when
// actually trying to attack (see handleStatus).
function tickNonAttackStatusSrv(poke, log) {
  // 兩格都可能是睡眠/結凍/混亂（2026-07-27改版後不再限制副格只能中毒/燒傷），都要各自倒數
  for (const slotKey of ['status', 'status2']) {
    const st = poke[slotKey];
    if (!st || (st.type !== 'sleep' && st.type !== 'freeze' && st.type !== 'confusion')) continue;
    st.turnsLeft--;
    if (st.turnsLeft <= 0) {
      poke[slotKey] = null;
      const msg = st.type === 'sleep' ? '從睡眠中醒來了！' : st.type === 'freeze' ? '解凍了，恢復行動！' : '從混亂中恢復了！';
      log.push({ text: `${poke.name} ${msg}`, cls: 'special' });
    }
  }
}

/* 負面狀態最多同時2個——2026-07-27新增，同一天內第二次調整：原本副格.status2故意設計成
   只能中毒/燒傷（避免要改handleStatus的阻擋判定），但使用者實際要的是任兩種都能疊加
   （例如睡眠+混亂、麻痺+結凍都要能同時存在），所以拿掉了這個限制——.status/.status2兩格
   現在完全對等，都可以是任何一種異常狀態。handleStatus/tickNonAttackStatusSrv也已經改成
   兩格都會檢查（見findStatusSlot()），不是只讀.status了。
   所有原本「直接指定poke.status = {...}」的地方都要改呼叫這個函式，回傳true代表真的套用成功
   （呼叫端可以再log訊息），false代表已達上限（兩格都滿）或該狀態已存在，什麼都不會發生。 */
function inflictStatus(G, poke, effect, turnsLeft) {
  // 治癒彩虹（鳳王專屬）：完全不會受到任何負面狀態——所有狀態賦予路徑最終都會呼叫這個共用函式
  if (poke.ability?.id === 'healing-rainbow') return false;
  // 魔法防守（magic-guard，2026-08-14新增：「不會被賦予負面狀態」）：跟healing-rainbow同一套
  // 「掛在共用函式最底層」寫法，涵蓋毒素碎片/辣椒噴霧/魅力等直接呼叫inflictStatus()的路徑
  if (poke.ability?.id === 'magic-guard') return false;
  // 2026-08-08修正：跟single-player同一個bug/同一套修法——妖精結界／極寒屏障的desc宣稱
  // 「免疫異常狀態」，原本這個檢查只放在tryInflictStatus（招式路徑），至少12張訓練師卡
  // 直接呼叫這個共用函式繞過了它，搬到這一層才能真正涵蓋所有賦予異常狀態的路徑
  const statusImmuneRole = poke === G.p1Deck?.[G.p1Idx] ? 'p1' : poke === G.p2Deck?.[G.p2Idx] ? 'p2' : null;
  if (statusImmuneRole && G[`${statusImmuneRole}StatusImmuneTurns`] > 0) return false;
  if (poke.status?.type === effect || poke.status2?.type === effect) return false;
  if (!poke.status) { poke.status = { type: effect, turnsLeft }; return true; }
  if (!poke.status2) { poke.status2 = { type: effect, turnsLeft }; return true; }
  return false;
}

// 治癒彩虹（鳳王專屬）：倒下時若還沒用過，原地復活（HP回滿50%、清除異常狀態），整場戰鬥限一次。
// server.js沒有像pokemon_battle.html的handleKO()那樣單一集中處理KO的函式，KO判定是每個造成傷害
// 的WS handler各自inline算「alive count」——所以這裡用一個共用helper，在每個「算完傷害、正要判斷
// 是否倒下」的地方都呼叫一次，而不是只加在單一個地方（跟集中式的單人版做法不同，是PvP架構本身的限制）
function tryHealingRainbowRevive(poke, log) {
  if (!poke || poke.cur > 0) return false;
  if (poke.ability?.id !== 'healing-rainbow' || poke._healingRainbowUsed) return false;
  poke._healingRainbowUsed = true;
  poke.cur = Math.round(poke.hp * 0.5);
  poke.status = null;
  poke.status2 = null;
  log.push({ text: `${poke.name} 的治癒彩虹發動，原地復活了！（HP ${poke.cur}/${poke.hp}）`, cls: 'special' });
  return true;
}

// Executes attack and mutates defender/buffs. Returns { damage, mult }.
function doAttack(attacker, defender, atk, aBuff, dBuff, log, G, switchGuardMult = 1, standbyGuardMult = 1) {
  const atkType   = aBuff.typeOverride || atk.type;
  // aRole/dRole moved up from further down (identity-comparison only, doesn't depend on anything
  // computed later) so the early-return immunity branches below can also respect 封印特性.
  const aRole = aBuff === G.p1Buff ? 'p1' : 'p2';
  const dRole = dBuff === G.p1Buff ? 'p1' : 'p2';
  // 蓄電（charge，2026-08-15新增）：標記這一側這回合真的出手攻擊了，供下次輪到自己回合開始時
  // 判斷「上個我方回合有沒有攻擊」（見drawForRole開頭的ChargeReady快照）
  G[`${aRole}AttackedLastOwnTurn`] = true;
  // 封印特性卡生效中的那一側，特性視為不存在——後面整個function一律讀attackerAbility/defenderAbility
  // 這兩個local變數，不要直接讀attacker.ability/defender.ability（那樣會繞過封印判定）
  const attackerAbility = isAbilitySealedSrv(aRole, G) ? null : attacker.ability;
  // 2026-08-14應使用者要求：破格（mold-breaker）從「無視對方的防禦型特性」擴大成「無視對手特性」，
  // 跟pokemon_battle.html的doAttack同一套處理——攻擊方是破格持有者時，defenderAbility整個視為null
  const defenderAbility = (isAbilitySealedSrv(dRole, G) || attackerAbility?.id === 'mold-breaker') ? null : defender.ability;
  // 機械之心（item-synergy，2026-08-14新增）：讀出上次觸發時設定的「下回合對手傷害-50」旗標，
  // 讀完立刻清空，跟pokemon_battle.html同一套「讀完即清」寫法
  const machineHeartReduction = G[`${dRole}MachineHeartShield`] || 0;
  G[`${dRole}MachineHeartShield`] = 0;
  // 辣椒噴霧（spicy-burn，2026-08-14新增）：對手使用非火屬性招式攻擊時，先讓對手燒傷，
  // 「再進行傷害計算」——一定要在下面burnMult算出來之前處理，跟pokemon_battle.html同一套順序
  // （這是burnMult宣告從原本函式最頂端移到這裡的唯一原因，其餘邏輯完全不變）
  if (defenderAbility?.id === 'spicy-burn' && atkType !== 'fire' && attacker.cur > 0) {
    if (inflictStatus(G, attacker, 'burn', 999)) {
      log.push({ text: `${defender.name} 的辣椒噴霧發動，讓${attacker.name} 燒傷了！`, cls: 'special' });
    }
  }
  // 熔岩火山：2026-08-13新增，此場地下燒傷的傷害倍率從一般的×0.7再加重到×0.1
  const burnMult  = attacker.status?.type === 'burn' ? (G.activeStadium?.id === 'stadium-lava' ? 0.1 : 0.7) : 1;

  // Reflect mirror: bounce damage back to attacker — 2026-07-27新增atk.ignoreReflect：無視對面
  // 反彈鏡的招式視為對方沒有架反彈鏡，直接照常造成傷害，反彈鏡護盾本身也一併消耗掉（2026-07-28
  // 應使用者回報「用了無視反彈鏡的招式，對方反彈鏡還在」修正：改成無論有沒有真的觸發反彈都會消耗）。
  // 2026-07-29新增aBuff.ignoreReflectNext（盧恩啟示卡片給的buff版無視反彈鏡，不限定招式）跟
  // reflectPierceMult（招式本身帶ignoreReflect、真的刺穿反彈鏡時傷害×2——只有招式版才有這個
  // 加成，盧恩啟示的buff版沒有，使用者的兩個需求分開描述，這裡刻意不共用）
  const reflectPierceMult = (dBuff.reflect && atk.ignoreReflect) ? 2 : 1;
  if (dBuff.reflect && (atk.ignoreReflect || aBuff.ignoreReflectNext)) {
    dBuff.reflect = false;
  }
  if (dBuff.reflect) {
    dBuff.reflect = false;
    // 2026-08-04應使用者要求「反彈鏡要算全套加成」——跟pokemon_battle.html同一版邏輯，複製主公式
    // （下面第981行左右那個大算式）並把attacker/defender角色互換（defender=B用反彈鏡彈回去，
    // 等於B才是這次真正在「攻擊」的一方，attacker=A變成挨打的一方）。刻意複製而非抽成共用函式、
    // 排除哪些項目的完整理由見pokemon_battle.html同一段的中文註解，兩邊需保持同步但沒有自動化機制檢查。
    // 2026-08-14修正：不動如山(true-damage)改成純防禦型「30%機率1HP存活」，跟破格系無關，拿掉
    const rMoldBreaker = defenderAbility?.id === 'mold-breaker' || defenderAbility?.id === 'shadow-tag-pierce';
    let rMult = srvEffActive(atkType, attacker.type, attacker.type2, G);
    if (!rMoldBreaker && attackerAbility?.id === 'no-weakness-dodge') rMult = Math.min(rMult, 1);
    // 2026-08-14新增：鐵拳／靜電／變幻自如反彈鏡鏡像版本，defenderAbility在這裡代表反彈鏡真正出手的一方
    if (defenderAbility?.id === 'dual-type-steel') rMult = Math.max(rMult, srvEffActive('steel', attacker.type, attacker.type2, G));
    if (defenderAbility?.id === 'static-paralyze-dual') rMult = Math.max(rMult, srvEffActive('electric', attacker.type, attacker.type2, G));
    if (defenderAbility?.id === 'protean-max') rMult = compressMult(2);
    const rIsOwnType = dBuff.typeOverride ? true : (atkType === defender.type || (defender.type2 && atkType === defender.type2));
    const rIsAdaptabilityMajor = rIsOwnType && defenderAbility?.id === 'adaptability-major';
    const rStabMult = rIsOwnType ? (rIsAdaptabilityMajor ? 1.4 : defenderAbility?.id === 'adaptability' ? 1.2 : 1.1) : 1;
    const rLowHpSelf = defender.cur <= defender.hp / 3;
    const rHalfHpSelf = defender.cur <= defender.hp / 2;
    const rTintedLensMult = (defenderAbility?.id === 'tinted-lens' && rMult > 0 && rMult < 1) ? (1 / rMult) : 1;
    const rAbilityDomainBonusApplies =
      (defenderAbility?.id === 'drizzle-ocean' && (atkType === 'water' || atkType === 'ice')) ||
      (defenderAbility?.id === 'drought-lava' && (atkType === 'ground' || atkType === 'fire')) ||
      (DOMAIN_ABILITY_STADIUM[defenderAbility?.id]?.type === atkType);
    const rAbilityDmgBonus = (defenderAbility?.id === 'huge-power') ? 40
      : (defenderAbility?.id === 'tough-claws') ? 40
      : (defenderAbility?.id === 'piercing-diamond') ? 40
      : (defenderAbility?.id === 'desperate-blade' && rHalfHpSelf) ? 40
      : (defenderAbility?.id === 'status-immune-once' && defender._temperedHeart) ? 40
      : (defenderAbility?.id === 'item-synergy' && G[`${dRole}UsedItemThisTurn`]) ? 40
      : rAbilityDomainBonusApplies ? 40
      : (defenderAbility?.id === 'crowned-sword-might') ? 30
      : 0;
    const rIsBlazeBoostFamily = defenderAbility?.id === 'blaze-boost' || defenderAbility?.id === 'hadron-engine' || defenderAbility?.id === 'crimson-pulse';
    const rAbilityDmgMult = ((rIsBlazeBoostFamily && rLowHpSelf && rIsOwnType) ? 1.1
      : (defenderAbility?.id === 'blaze-boost-pure' && rLowHpSelf) ? 1.1
      : (defenderAbility?.id === 'thick-fat-pure' && rLowHpSelf) ? 1.2
      : 1) * rTintedLensMult;
    const rThickFatMult  = (!rMoldBreaker && attackerAbility?.id === 'thick-fat' && (atkType === 'fire' || atkType === 'ice')) ? 0.92 : 1;
    const rSolidRockMult = (!rMoldBreaker && attackerAbility?.id === 'solid-rock' && rMult >= 1.2) ? 0.95 : 1;
    const rFriskWardMult = (!rMoldBreaker && attackerAbility?.id === 'frisk-ward' && Math.random() < 0.25) ? 0.9 : 1;
    const rMultiscaleMult = (!rMoldBreaker && attackerAbility?.id === 'multiscale' && attacker.cur === attacker.hp) ? 0.1 : 1;
    const rThickFatPureReduction = (!rMoldBreaker && attackerAbility?.id === 'thick-fat-pure') ? 50 : 0;
    const rSolidRockFlatReduction = (!rMoldBreaker && attackerAbility?.id === 'solid-rock-flat') ? 30 : 0;
    const rDefAbilityMult = rThickFatMult * rSolidRockMult * rFriskWardMult * rMultiscaleMult;
    const rMegaBoostBonus = !defender.mega ? 40 : defender.megaEvolved ? 100 : -20;
    const rBonusVsTypeBonus = (atk.bonusVsType && (attacker.type === atk.bonusVsType || attacker.type2 === atk.bonusVsType)) ? 50 : 0;
    // 2026-08-11修正：rider:'self-cure'（命中解除自身異常狀態）原本是純粹的固定+40（改壞了使用者
    // 的原意）——使用者要的是「有異常狀態才解除+加傷，沒有就正常傷害」，改成條件式：攻擊當下
    // （治療生效之前）自己身上有異常狀態才+40，跟rAbilityDmgBonus同樣用defender代表反彈鏡情境下
    // 「實際出招的一方」，判斷順序在rider真正執行（清除status）之前，所以這裡讀到的還是清除前的狀態
    const rSelfCureBonus = (atk.rider === 'self-cure' && (defender.status || defender.status2)) ? 40 : 0;
    // 2026-08-13場地卡重新設計，理由跟主公式同一段說明，這裡是反彈鏡情境下的鏡像版本
    const rMysticSpaceReduction = (G.activeStadium?.id === 'stadium-mystic-space' && (attacker.type === 'psychic' || attacker.type2 === 'psychic')) ? 50 : 0;
    const rLavaBonus = (G.activeStadium?.id === 'stadium-lava' && atkType === 'fire' && !rAbilityDomainBonusApplies) ? 50 : 0;
    const rLavaMult = (G.activeStadium?.id === 'stadium-lava' && atkType === 'water') ? 0.3 : 1;
    const rOceanMoveBonus = (G.activeStadium?.id === 'stadium-ocean' && atkType === 'water' && !rAbilityDomainBonusApplies) ? 20 : 0;
    const rRockFieldBonus = (G.activeStadium?.id === 'stadium-rock-field' && (atkType === 'rock' || atkType === 'ground') && !rAbilityDomainBonusApplies) ? 50 : 0;
    const rRockFieldReduction = (G.activeStadium?.id === 'stadium-rock-field' && (attacker.type === 'rock' || attacker.type2 === 'rock' || attacker.type === 'ground' || attacker.type2 === 'ground')) ? 50 : 0;
    const rShrineReduction = (G.activeStadium?.id === 'stadium-shrine' && (attacker.type === 'normal' || attacker.type2 === 'normal')) ? 50 : 0;
    const rElectricStormBonus = (G.activeStadium?.id === 'stadium-electric-storm' && atkType === 'electric' && !rAbilityDomainBonusApplies) ? 30 : 0;
    const rIceTundraBonus = (G.activeStadium?.id === 'stadium-ice-tundra' && atkType === 'ice' && !rAbilityDomainBonusApplies) ? 30 : 0;
    const rIceTundraReduction = (G.activeStadium?.id === 'stadium-ice-tundra' && (attacker.type === 'ice' || attacker.type2 === 'ice')) ? 50 : 0;
    const rSteelFortressBonus = (G.activeStadium?.id === 'stadium-steel-fortress' && atkType === 'steel' && !rAbilityDomainBonusApplies) ? 30 : 0;
    const rBugHiveBonus = (G.activeStadium?.id === 'stadium-bug-hive' && atkType === 'bug' && !rAbilityDomainBonusApplies) ? 30 : 0;
    const rFairyWardBonus = (G.activeStadium?.id === 'stadium-fairy-ward' && atkType === 'fairy' && !rAbilityDomainBonusApplies) ? 30 : 0;
    const rDarkCurseMult = (G.activeStadium?.id === 'stadium-dark-curse' && atkType === 'dark' && !rAbilityDomainBonusApplies) ? 1.2 : 1;
    const rFlyingWindMult = (G.activeStadium?.id === 'stadium-flying-wind' && atkType === 'flying' && !rAbilityDomainBonusApplies) ? 1.2 : 1;
    const rSteelFortressReduction = (G.activeStadium?.id === 'stadium-steel-fortress' && (attacker.type === 'steel' || attacker.type2 === 'steel')) ? 50 : 0;
    const rMegaPrismMult = (G.activeStadium?.id === 'stadium-mega-prism' && (attacker.mega || attacker.megaEvolved)) ? 0.6 : 1;
    const rStadiumMult = rLavaMult * rDarkCurseMult * rFlyingWindMult * rMegaPrismMult;
    const rStadiumFlatBonus = rLavaBonus + rOceanMoveBonus + rRockFieldBonus + rElectricStormBonus + rIceTundraBonus + rSteelFortressBonus + rBugHiveBonus + rFairyWardBonus;
    // 2026-08-14修正：顛倒之心已從shield-invert搬到contrary-heart（見下方symmetric reversal），
    // 這裡拿掉舊的shield-invert分支；新增不屈之心（guts-half-survive）「攻擊不會被對手減傷」
    const rShieldTerm = (dBuff.ignoreShield || atk.ignoreShield || defenderAbility?.id === 'crowned-sword-might' || defenderAbility?.id === 'shadow-tag-pierce' || defenderAbility?.id === 'guts-half-survive') ? 0 : aBuff.shield;
    const rCrownedShieldReduction = attackerAbility?.id === 'crowned-shield-aegis' ? 30 : 0;
    const rBurnMult = defender.status?.type === 'burn' ? (G.activeStadium?.id === 'stadium-lava' ? 0.1 : 0.7) : 1;
    let dmg = (rMult === 0) ? 0 : Math.max(0, Math.max(1, Math.floor(
      (atk.dmg + dBuff.atkBonus + rStadiumFlatBonus + rAbilityDmgBonus + rMegaBoostBonus + rBonusVsTypeBonus + rSelfCureBonus) *
      dBuff.atkMult * rBurnMult * rMult * rStabMult * rAbilityDmgMult * rDefAbilityMult * rStadiumMult
    )) - rShieldTerm - rRockFieldReduction - rSteelFortressReduction - rShrineReduction - rCrownedShieldReduction - rMysticSpaceReduction - rIceTundraReduction - rThickFatPureReduction - rSolidRockFlatReduction);
    // 唱反調（contrary-mirror）／顛倒之心（contrary-heart，2026-08-14新增）：反彈鏡情境下
    // attackerAbility代表「實際承受傷害的一方」，跟主公式同一套對稱算法
    const rContraryHeartOnField = (!isAbilitySealedSrv('p1', G) && G.p1Deck[G.p1Idx]?.ability?.id === 'contrary-heart' && G.p1Deck[G.p1Idx]?.cur > 0)
      || (!isAbilitySealedSrv('p2', G) && G.p2Deck[G.p2Idx]?.ability?.id === 'contrary-heart' && G.p2Deck[G.p2Idx]?.cur > 0);
    if (!rMoldBreaker && (attackerAbility?.id === 'contrary-mirror' || rContraryHeartOnField) && rMult > 0) {
      const rBaseDmg = Math.max(1, Math.floor(atk.dmg * rMult * rStabMult));
      dmg = Math.max(0, Math.floor(2 * rBaseDmg - dmg));
    }
    attacker.cur  = Math.max(0, attacker.cur - dmg);
    log.push({ text: `反彈鏡！攻擊被反彈，${attacker.name} 承受了 ${dmg} 傷害！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFreeType = null; aBuff.costHalved = false; aBuff.ignoreReflectNext = false; aBuff.iceHowlFreeze = false; dBuff.shield = 0; dBuff.iceImmune = false;
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
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFreeType = null; aBuff.costHalved = false; aBuff.ignoreReflectNext = false; aBuff.iceHowlFreeze = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }

  /* Motor Drive: full immunity to electric-type moves, gains energy instead */
  if (defenderAbility?.id === 'motor-drive' && atkType === 'electric') {
    G[`${dRole}Energy`] = Math.min(20, (G[`${dRole}Energy`] || 0) + 3);
    log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });
    log.push({ text: `${defender.name} 的電氣引擎吸收了攻擊，回復了 3 點能量！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFreeType = null; aBuff.costHalved = false; aBuff.ignoreReflectNext = false; aBuff.iceHowlFreeze = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }

  // 飄浮（levitate，2026-08-15重新設計）：受到地面屬性攻擊時完全免疫（10%閃避的部分在mult計算
  // 之後的shockStadiumDodgeProc家族處理）
  if (defenderAbility?.id === 'levitate' && atkType === 'ground') {
    log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });
    log.push({ text: `${defender.name} 的飄浮讓地面屬性攻擊完全沒有效果！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFreeType = null; aBuff.costHalved = false; aBuff.ignoreReflectNext = false; aBuff.iceHowlFreeze = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }

  /* Flash Fire: full immunity to fire-type moves, boosts own next attack instead */
  if (defenderAbility?.id === 'flash-fire' && atkType === 'fire') {
    dBuff.atkBonus = 50; // 2026-08-15：引火從+20上修到+50
    log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });
    log.push({ text: `${defender.name} 的引火吸收了攻擊，下次攻擊威力提升！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFreeType = null; aBuff.costHalved = false; aBuff.ignoreReflectNext = false; aBuff.iceHowlFreeze = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }
  // 熱交換（flash-fire-major，2026-08-14從guts分家）：跟引火同一套「火屬性完全免疫、下次攻擊+N」
  // 寫法，只是N從20上修到40，跟pokemon_battle.html的doAttack同一套處理
  if (defenderAbility?.id === 'flash-fire-major' && atkType === 'fire') {
    dBuff.atkBonus = Math.max(dBuff.atkBonus, 40);
    log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });
    log.push({ text: `${defender.name} 的${defenderAbility.name}吸收了攻擊，下次攻擊威力提升！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFreeType = null; aBuff.costHalved = false; aBuff.ignoreReflectNext = false; aBuff.iceHowlFreeze = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }

  let mult = srvEffActive(atkType, defender.type, defender.type2, G);
  // 2026-08-14新增：鐵拳／靜電（dual-type-steel/static-paralyze-dual）「招式屬性以及X屬性擇優計算」
  if (attackerAbility?.id === 'dual-type-steel') mult = Math.max(mult, srvEffActive('steel', defender.type, defender.type2, G));
  if (attackerAbility?.id === 'static-paralyze-dual') mult = Math.max(mult, srvEffActive('electric', defender.type, defender.type2, G));
  // 變幻自如（protean-max）：攻擊一律視為克制對手的屬性
  if (attackerAbility?.id === 'protean-max') mult = compressMult(2);
  // 2026-08-15新增：龍化/妖精皮膚/飛行皮膚，跟鐵拳/靜電同一套「招式屬性以及X屬性擇優計算」
  if (attackerAbility?.id === 'dragonize') mult = Math.max(mult, srvEffActive('dragon', defender.type, defender.type2, G));
  if (attackerAbility?.id === 'fairy-skin') mult = Math.max(mult, srvEffActive('fairy', defender.type, defender.type2, G));
  if (attackerAbility?.id === 'flying-skin') mult = Math.max(mult, srvEffActive('flying', defender.type, defender.type2, G));
  // 破格系特性：既有的mold-breaker（Mega限定）+ true-damage（不動如山）+ 踩影（shadow-tag-pierce，
  // 2026-08-14新增，攻擊不會被閃避也不會被減傷）共用同一個布林
  // 2026-08-14修正：不動如山(true-damage)改成純防禦型「30%機率1HP存活」，跟破格系無關，拿掉
  const moldBreaker = attackerAbility?.id === 'mold-breaker' || attackerAbility?.id === 'shadow-tag-pierce';
  // 貫穿之鑽（piercing-diamond，2026-08-15新增）：攻擊不會被對手減傷——跟moldBreaker一樣可以
  // 忽略固定/乘數類減傷特性，但不影響閃避／弱點相關判定，所以獨立開一個布林
  const ignoresReduction = moldBreaker || attackerAbility?.id === 'piercing-diamond';
  // 深淵支配：不會受到超效傷害（型效乘數封頂在1，只降不升，不影響自己剋制對方時的正常效果）
  // （2026-08-04：伊裴爾塔爾專屬的no-weakness-dodge-60已改成dark-abyss-lockdown，效果完全不同，
  // 不再屬於這個閃避家族，這裡只剩暴鯉龍/化石翼龍/冰岩怪共用的10%版本）
  const isAbyssDodgeFamily = defenderAbility?.id === 'no-weakness-dodge';
  if (!moldBreaker && isAbyssDodgeFamily) mult = Math.min(mult, 1);
  // 屬性轉換 (type-orb) makes the overridden type count as own for STAB purposes — pure upside.
  const isOwnType = aBuff.typeOverride ? true : (atkType === attacker.type || (attacker.type2 && atkType === attacker.type2));
  const isAdaptability = isOwnType && attackerAbility?.id === 'adaptability';
  // 適應力（adaptability-major，2026-08-14從×1.2上修到×1.4）
  const isAdaptabilityMajor = isOwnType && attackerAbility?.id === 'adaptability-major';
  // 2026-08-15新增：龍化STAB×1.2跟舊adaptability同值；冰肌/飛毛腿STAB×1.4跟adaptability-major同值，
  // 但這兩個各自還帶額外效果，不能直接掛在共用id上，所以獨立判斷
  const is14StabId = attackerAbility?.id === 'ice-skin' || attackerAbility?.id === 'quick-feet';
  const is12StabId = attackerAbility?.id === 'dragonize';
  const stabMult = isOwnType ? (isAdaptabilityMajor || is14StabId ? 1.4 : isAdaptability || is12StabId ? 1.2 : 1.1) : 1;
  // 2026-07-22應使用者要求「場地卡全面加強，成為對戰核心策略」，16張場地卡數值全面上調
  // 2026-07-24應使用者要求「場地卡太過強勢」，把傷害倍率壓回~1.2、固定加成>40的下修到30以下
  const stadiumBonus = G?.activeStadium?.id === 'stadium-training' ? 25 : 0;
  const reversalBonus = G?.activeStadium?.id === 'stadium-reversal' && attacker.cur <= attacker.hp * 0.5 ? 30 : 0;
  const lowHpSelf = attacker.cur <= attacker.hp / 3;
  const halfHpSelf = attacker.cur <= attacker.hp / 2;
  const tintedLensProc = attackerAbility?.id === 'tinted-lens' && mult > 0 && mult < 1;
  const tintedLensMult = tintedLensProc ? (1 / mult) : 1; // cancels out resisted (but not immune) hits
  // 米立龍系特性「指揮」：上一隻我方寶可夢離場時留下的一次性buff，被這次攻擊消耗（能量折扣在attack handler處理，這裡只處理傷害）
  const legacyBuff = G[`${aRole}LegacyBuff`];
  // 2026-07-22應使用者要求：原本是×1.02倍率，跟下面一整批弱倍率特性一起改成固定+40傷害
  const legacyDmgBonus = legacyBuff ? 40 : 0;
  if (legacyBuff) G[`${aRole}LegacyBuff`] = null;
  // 機械之心（item-synergy，2026-08-14新增「並且下回合對手造成的傷害-50」）：跟下面abilityDmgBonus
  // 讀同一個觸發條件，這裡額外設定下回合生效的減傷旗標，跟pokemon_battle.html同步
  if (attackerAbility?.id === 'item-synergy' && G[`${aRole}UsedItemThisTurn`]) {
    G[`${aRole}MachineHeartShield`] = 50;
  }
  // 以下弱倍率特性（原本1.02~1.06）全部改成固定+40傷害；仍≥1.1的（猛火/技術高手）維持原本倍率寫法不變
  const abilityDmgBonus = (attackerAbility?.id === 'huge-power') ? 40
    : (attackerAbility?.id === 'tough-claws') ? 40
    : (attackerAbility?.id === 'piercing-diamond') ? 40
    : (attackerAbility?.id === 'desperate-blade' && halfHpSelf) ? 40
    : (attackerAbility?.id === 'status-immune-once' && attacker._temperedHeart) ? 40
    : (attackerAbility?.id === 'item-synergy' && G[`${aRole}UsedItemThisTurn`]) ? 40
    : (attackerAbility?.id === 'drizzle-ocean' && (atkType === 'water' || atkType === 'ice')) ? 40
    : (attackerAbility?.id === 'drought-lava' && (atkType === 'ground' || atkType === 'fire')) ? 40
    : (DOMAIN_ABILITY_STADIUM[attackerAbility?.id]?.type === atkType) ? 40
    : (attackerAbility?.id === 'crowned-sword-might') ? 30
    : (attackerAbility?.id === 'fighting-flat-bonus' && atkType === 'fighting') ? 20
    : 0;
  // 2026-08-04全面稽核：領域特性持有者onEnter會自動切換到「剛好加成自己本系招式」的場地卡，
  // 導致abilityDmgBonus的+40跟場地卡自己對該屬性招式的加成疊加算兩次（跟海洋世界/毒刺水母
  // 那次同一個bug pattern，稽核後發現9張場地卡都有），統一用這個旗標擋掉，見pokemon_battle.html同名變數的說明。
  const abilityDomainBonusApplies =
    (attackerAbility?.id === 'drizzle-ocean' && (atkType === 'water' || atkType === 'ice')) ||
    (attackerAbility?.id === 'drought-lava' && (atkType === 'ground' || atkType === 'fire')) ||
    (DOMAIN_ABILITY_STADIUM[attackerAbility?.id]?.type === atkType);
  // 龍之谷：2026-08-13重新設計，拿掉原本的+35固定傷害（新spec只剩弱點消除/不減免/能量折扣，
  // 能量折扣已在effectiveCostSrv實作，這裡不用再加任何傷害項）
  // 強子引擎(密勒頓)/緋紅脈動(故勒頓)：各自專屬id，沿用blaze-boost同樣的「HP<1/3本系傷害×1.1」判定
  const isBlazeBoostFamily = attackerAbility?.id === 'blaze-boost' || attackerAbility?.id === 'hadron-engine' || attackerAbility?.id === 'crimson-pulse';
  // 2026-08-14新增：茂盛（blaze-boost-pure）／厚脂肪（thick-fat-pure）的HP<1/3加成，不限本系招式
  const abilityDmgMult = ((isBlazeBoostFamily && lowHpSelf && isOwnType) ? 1.1
    : (attackerAbility?.id === 'blaze-boost-pure' && lowHpSelf) ? 1.1
    : (attackerAbility?.id === 'thick-fat-pure' && lowHpSelf) ? 1.2
    : (attackerAbility?.id === 'dark-jaw-discard' && atkType === 'dark') ? 1.4
    // 蓄電（charge，2026-08-15重新設計）：上個我方回合沒有攻擊，這回合攻擊傷害×2
    : (attackerAbility?.id === 'charge' && G[`${aRole}ChargeReady`]) ? 2
    : 1) * tintedLensMult;
  const thickFatMult  = (!ignoresReduction && defenderAbility?.id === 'thick-fat' && (atkType === 'fire' || atkType === 'ice')) ? 0.92 : 1;
  const solidRockMult = (!ignoresReduction && defenderAbility?.id === 'solid-rock' && mult >= 1.2) ? 0.95 : 1;
  const friskWardProc = !moldBreaker && defenderAbility?.id === 'frisk-ward' && Math.random() < 0.25;
  const friskWardMult = friskWardProc ? 0.9 : 1;
  const wasFullHp = defender.cur === defender.hp;
  // 硬殼盔甲（sturdy-half，2026-08-14新增）：門檻從HP全滿放寬成HP>50%，扣血前先算好快照
  const wasAboveHalfHp = defender.cur > defender.hp / 2;
  // 結實（sturdy-30pct，2026-08-14新增）：門檻改成HP>30%，同樣要在扣血前先算好快照
  const wasAboveThirtyPct = defender.cur > defender.hp * 0.3;
  // 魔法防守（magic-guard，2026-08-14新增）：受到攻擊時50%機率傷害×0.5
  const magicGuardProc = !moldBreaker && defenderAbility?.id === 'magic-guard' && Math.random() < 0.5;
  const magicGuardMult = magicGuardProc ? 0.5 : 1;
  // 神秘防守（mystic-guard，2026-08-15新增）：受到攻擊時擲一枚硬幣，正面則傷害×0.75
  const mysticGuardHeads = !moldBreaker && defenderAbility?.id === 'mystic-guard' && Math.random() < 0.5;
  const mysticGuardMult = mysticGuardHeads ? 0.75 : 1;
  // 魅力（cute-charm-confuse，2026-08-14新增）：受到攻擊時40%機率傷害×0.8
  const cuteCharmProc = !moldBreaker && defenderAbility?.id === 'cute-charm-confuse' && Math.random() < 0.4;
  const cuteCharmMult = cuteCharmProc ? 0.8 : 1;
  // 2026-08-14應使用者要求：多重鱗片從×0.9下修到×0.1
  const multiscaleMult = (!ignoresReduction && defenderAbility?.id === 'multiscale' && wasFullHp) ? 0.1 : 1;
  // 厚脂肪（thick-fat-pure）／硬岩（solid-rock-flat）2026-08-14新增：固定減傷，不進defAbilityMult
  // 乘法鏈，改成跟rockFieldReduction同一套「乘法鏈算完後再扣」寫法
  const thickFatPureReduction = (!ignoresReduction && defenderAbility?.id === 'thick-fat-pure') ? 50 : 0;
  const solidRockFlatReduction = (!ignoresReduction && defenderAbility?.id === 'solid-rock-flat') ? 30 : 0;
  const defAbilityMult = thickFatMult * solidRockMult * friskWardMult * multiscaleMult * magicGuardMult * cuteCharmMult * mysticGuardMult;
  // 2026-07-22應使用者要求：Mega進化通用加成原本×1.02，改成固定+40傷害
  // 2026-07-31應使用者要求再調整為三段式：不能mega的寶可夢基礎傷害要更高、能mega但還沒
  // 進化的要更低、mega進化後要比不能mega的更高——維持同一套「固定加成」寫法，跟
  // pokemon_battle.html同步（見該檔案同一行的完整說明）
  const megaBoostBonus = !attacker.mega ? 40 : attacker.megaEvolved ? 100 : -20;
  // 使用者要求「傷害高的招式，遇到特定屬性可以加攻」：部分高消耗招式帶bonusVsType欄位，
  // 命中該屬性對手時額外+50固定傷害，跟pokemon_battle.html的doAttack同一套處理
  const bonusVsTypeBonus = (atk.bonusVsType && (defender.type === atk.bonusVsType || defender.type2 === atk.bonusVsType)) ? 50 : 0;
  // 2026-08-11修正：rider:'self-cure'同上（見rSelfCureBonus的說明），這裡是一般（非反彈）攻擊路徑，
  // attacker就是實際出招的一方，直接讀attacker.status/status2
  const selfCureBonus = (atk.rider === 'self-cure' && (attacker.status || attacker.status2)) ? 40 : 0;
  // 2026-08-13場地卡全面重新設計（見battle-logic skill同名章節）——羅馬鬥技場/亡靈墓園/魔幻空間
  // 三張的傷害倍率拿掉，改成共用的雙重攻擊機制（見attackWithStadiumDoubleSrv）；
  // 以下維持「9張領域特性→自動切換的場地」都補上!abilityDomainBonusApplies，理由見上面宣告處
  const mysticSpaceReduction = (G.activeStadium?.id === 'stadium-mystic-space' && (defender.type === 'psychic' || defender.type2 === 'psychic')) ? 50 : 0;
  // Lava Volcano: fire-type moves固定加成（+30→+50上修）；water-type moves ×0.65→×0.3下修
  const lavaBonus = (G.activeStadium?.id === 'stadium-lava' && atkType === 'fire' && !abilityDomainBonusApplies) ? 50 : 0;
  const lavaMult = (G.activeStadium?.id === 'stadium-lava' && atkType === 'water') ? 0.3 : 1;
  // Ocean World：電屬性加成整個拿掉，改成水屬性「招式」固定+20傷害（不再是攻擊方種族屬性）
  const oceanMoveBonus = (G.activeStadium?.id === 'stadium-ocean' && atkType === 'water' && !abilityDomainBonusApplies) ? 20 : 0;
  // 岩石地帶：弱點消除縮小成岩石／地面（鋼屬性移到專屬的鋼鐵堡壘），受到攻擊固定減傷維持50，
  // 新增「岩石／地面招式攻擊造成的傷害+50」（招式屬性決定，不是攻擊方種族屬性，跟海洋世界
  // oceanMoveBonus同一套寫法，一樣要排除rock-domain持有者打岩石招式時的雙重加成）
  const rockFieldBonus = (G.activeStadium?.id === 'stadium-rock-field' &&
    (atkType === 'rock' || atkType === 'ground') && !abilityDomainBonusApplies) ? 50 : 0;
  const rockFieldReduction = (G.activeStadium?.id === 'stadium-rock-field' &&
    (defender.type === 'rock' || defender.type2 === 'rock' || defender.type === 'ground' || defender.type2 === 'ground')) ? 50 : 0;
  // 莊嚴神社：一般屬性寶可夢受到攻擊固定減傷（30→50上修）
  const shrineReduction = (G.activeStadium?.id === 'stadium-shrine' &&
    (defender.type === 'normal' || defender.type2 === 'normal')) ? 50 : 0;
  const electricStormBonus = (G.activeStadium?.id === 'stadium-electric-storm' && atkType === 'electric' && !abilityDomainBonusApplies) ? 30 : 0;
  // 永凍冰原：新增冰屬性寶可夢受到攻擊固定減傷50
  const iceTundraBonus = (G.activeStadium?.id === 'stadium-ice-tundra' && atkType === 'ice' && !abilityDomainBonusApplies) ? 30 : 0;
  const iceTundraReduction = (G.activeStadium?.id === 'stadium-ice-tundra' && (defender.type === 'ice' || defender.type2 === 'ice')) ? 50 : 0;
  const steelFortressBonus = (G.activeStadium?.id === 'stadium-steel-fortress' && atkType === 'steel' && !abilityDomainBonusApplies) ? 30 : 0;
  const bugHiveBonus = (G.activeStadium?.id === 'stadium-bug-hive' && atkType === 'bug' && !abilityDomainBonusApplies) ? 30 : 0;
  const fairyWardBonus = (G.activeStadium?.id === 'stadium-fairy-ward' && atkType === 'fairy' && !abilityDomainBonusApplies) ? 30 : 0;
  const darkCurseMult = (G.activeStadium?.id === 'stadium-dark-curse' && atkType === 'dark' && !abilityDomainBonusApplies) ? 1.2 : 1;
  const flyingWindMult = (G.activeStadium?.id === 'stadium-flying-wind' && atkType === 'flying' && !abilityDomainBonusApplies) ? 1.2 : 1;
  // 鋼鐵堡壘：從「不限屬性、雙方受到攻擊固定-20」改成「鋼屬性寶可夢受到攻擊固定-50」，鋼屬性
  // 招式傷害+30（steelFortressBonus）不變
  const steelFortressReduction = (G.activeStadium?.id === 'stadium-steel-fortress' && (defender.type === 'steel' || defender.type2 === 'steel')) ? 50 : 0;
  // Mega稜鏡塔：可Mega進化或已經Mega進化的寶可夢受到攻擊×0.6，跟pokemon_battle.html的doAttack同一套處理
  const megaPrismMult = (G.activeStadium?.id === 'stadium-mega-prism' && (defender.mega || defender.megaEvolved)) ? 0.6 : 1;
  const stadiumMult = lavaMult * darkCurseMult * flyingWindMult * megaPrismMult;
  const stadiumFlatBonus = stadiumBonus + reversalBonus + lavaBonus + oceanMoveBonus + rockFieldBonus +
    electricStormBonus + iceTundraBonus + steelFortressBonus + bugHiveBonus + fairyWardBonus;
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
    // 2026-08-15：威壓氣場（weaken-buffs）全面替換為onEnter主動效果，這裡不再有id分支
    const effectiveAtkMult = aBuff.atkMult;
    // 烏賊王「顛倒之心」：對手的防禦加成（shield）對它反而變成傷害加成
    // 直搗黃龍：無視對方的shield（受傷減少）效果，這次攻擊當它不存在
    // 2026-07-31新增atk.ignoreShield：部分高消耗招式自帶「無視盾牌」（跟既有的buff版
    // aBuff.ignoreShield／直搗黃龍卡片並存，任一個成立就無視）
    // 2026-08-14修正：顛倒之心已從shield-invert搬到contrary-heart，這裡拿掉舊分支；
    // 新增不屈之心（guts-half-survive）「攻擊不會被對手減傷」
    const shieldTerm = (aBuff.ignoreShield || atk.ignoreShield || attackerAbility?.id === 'crowned-sword-might' || attackerAbility?.id === 'shadow-tag-pierce' || attackerAbility?.id === 'guts-half-survive' || attackerAbility?.id === 'piercing-diamond') ? 0 : dBuff.shield;
    const crownedShieldReduction = defenderAbility?.id === 'crowned-shield-aegis' ? 30 : 0;
    // 2026-07-30應使用者回報「傷害計算怪怪的」修正：固定減傷（shieldTerm/rockFieldReduction/
    // steelFortressReduction）疊加起來可能超過乘法鏈算出來的傷害本身，原本扣減後沒有再夾在0以上，
    // 會讓damage變成負數，等同攻擊反而幫defender加血。外層包Math.max(0,...)避免倒扣出負傷害。
    // 2026-08-13：雙重攻擊（羅馬鬥技場/亡靈墓園/魔幻空間共用）第二段攻擊的×0.4要乘在整條
    // 乘法鏈最後面（atk._secondHitMult，2026-08-04原本是colosseum專屬的atk._halfDamage/固定0.5，
    // 現在改成通用欄位／0.4），不能只砍atk.dmg這個小加項——megaBoostBonus/abilityDmgBonus等
    // 固定加成完全不會被砍到，導致第二段幾乎跟第一段一樣高（使用者回報「兩下攻擊都超過300」）。
    damage = Math.max(0, Math.max(1, Math.floor((atk.dmg + aBuff.atkBonus + stadiumFlatBonus + legacyDmgBonus + abilityDmgBonus + megaBoostBonus + typeBoostBonus + bonusVsTypeBonus + selfCureBonus) * effectiveAtkMult * burnMult * mult * stabMult * switchGuardMult * standbyGuardMult * abilityDmgMult * defAbilityMult * stadiumMult * typeBoostMult * reflectPierceMult * (atk._secondHitMult ?? 1))) - shieldTerm - rockFieldReduction - steelFortressReduction - shrineReduction - crownedShieldReduction - mysticSpaceReduction - iceTundraReduction - thickFatPureReduction - solidRockFlatReduction - machineHeartReduction);
    // 唱反調（contrary-mirror）／顛倒之心（contrary-heart，2026-08-14新增）：確認過的「對稱」算法——
    // baseDmg是完全沒有任何加成/減傷、只剩基礎威力×屬性相克×STAB的基準傷害，最終傷害＝
    // 2×baseDmg－本來會受到的dmg。唱反調只在defender持有時生效；顛倒之心不限持有者是否為defender，
    // 只要在場上（任一方）就對雙方攻擊都套用，跟pokemon_battle.html同步
    const contraryHeartOnField = (!isAbilitySealedSrv('p1', G) && G.p1Deck[G.p1Idx]?.ability?.id === 'contrary-heart' && G.p1Deck[G.p1Idx]?.cur > 0)
      || (!isAbilitySealedSrv('p2', G) && G.p2Deck[G.p2Idx]?.ability?.id === 'contrary-heart' && G.p2Deck[G.p2Idx]?.cur > 0);
    if (!moldBreaker && (defenderAbility?.id === 'contrary-mirror' || contraryHeartOnField)) {
      const baseDmg = Math.max(1, Math.floor(atk.dmg * mult * stabMult));
      damage = Math.max(0, Math.floor(2 * baseDmg - damage));
    }
    // 影舞：下一次受到攻擊擲硬幣，正面完全免傷——一次性旗標，這次攻擊到來就消耗掉（不論正反面）。true-damage系特性無視此效果。
    if (!moldBreaker && G[`${dRole}CoinShield`]) {
      G[`${dRole}CoinShield`] = false;
      if (Math.random() < 0.5) {
        damage = 0;
        log.push({ text: `${defender.name} 的影舞擲出硬幣正面，完全閃避了攻擊！`, cls: 'special' });
      }
    }
    // 深淵支配：被動閃避攻擊（每次受擊都會骰，不是一次性旗標）。true-damage系特性無視此效果。10%機率。
    if (!moldBreaker && damage > 0 && isAbyssDodgeFamily && Math.random() < 0.1) {
      damage = 0;
      log.push({ text: `${defender.name} 的深淵支配發動，完全閃避了攻擊！`, cls: 'special' });
    }
    // 場地卡閃避（2026-08-13重新設計）：疾風之翼(flying,50%)／劇毒領域(poison,20%，從50%下修)／
    // 沙塵暴(ground/rock,70%，新增)／蟲群巢穴(bug,50%，新增)——各卡機率不同，查STADIUM_DODGE表，
    // 跟pokemon_battle.html的doAttack同一套「dmg>0才骰、true-damage無視、不疊加其他閃避來源」寫法
    const stadiumDodgeCfg = STADIUM_DODGE[G.activeStadium?.id];
    const stadiumDodgeActive = stadiumDodgeCfg &&
      (stadiumDodgeCfg.types.includes(defender.type) || stadiumDodgeCfg.types.includes(defender.type2));
    if (!moldBreaker && damage > 0 && stadiumDodgeActive && Math.random() < stadiumDodgeCfg.chance) {
      damage = 0;
      log.push({ text: `${defender.name} 靠著【${G.activeStadium.name}】完全閃避了攻擊！`, cls: 'special' });
    }
    // 電氣場地（shock-stadium-dodge，2026-08-14新增）：20%機率完全閃避，跟深淵支配同一套「自身特性、
    // 不看場地」的被動閃避寫法，跟pokemon_battle.html的doAttack同一套處理
    if (!moldBreaker && damage > 0 && defenderAbility?.id === 'shock-stadium-dodge' && Math.random() < 0.2) {
      damage = 0;
      log.push({ text: `${defender.name} 的${defenderAbility.name}發動，完全閃避了攻擊！`, cls: 'special' });
    }
    // 揚沙（sandstorm-stadium-dodge，2026-08-14新增）：跟電氣場地同一套「自身特性、20%完全閃避」寫法
    if (!moldBreaker && damage > 0 && defenderAbility?.id === 'sandstorm-stadium-dodge' && Math.random() < 0.2) {
      damage = 0;
      log.push({ text: `${defender.name} 的${defenderAbility.name}發動，完全閃避了攻擊！`, cls: 'special' });
    }
    // 反轉世界（reverse-world-dodge，2026-08-14新增，騎拉帝納專屬）：同一套寫法，機率降到10%
    if (!moldBreaker && damage > 0 && defenderAbility?.id === 'reverse-world-dodge' && Math.random() < 0.1) {
      damage = 0;
      log.push({ text: `${defender.name} 的${defenderAbility.name}發動，完全閃避了攻擊！`, cls: 'special' });
    }
    // 飛行皮膚（flying-skin，2026-08-15新增）：同一套被動閃避寫法，10%機率完全閃避
    if (!moldBreaker && damage > 0 && defenderAbility?.id === 'flying-skin' && Math.random() < 0.1) {
      damage = 0;
      log.push({ text: `${defender.name} 的${defenderAbility.name}發動，完全閃避了攻擊！`, cls: 'special' });
    }
    // 飄浮（levitate，2026-08-15重新設計）：同一套被動閃避寫法，10%機率完全閃避
    if (!moldBreaker && damage > 0 && defenderAbility?.id === 'levitate' && Math.random() < 0.1) {
      damage = 0;
      log.push({ text: `${defender.name} 的${defenderAbility.name}發動，完全閃避了攻擊！`, cls: 'special' });
    }
    // 蟲之預感（bug-sense-dodge，2026-08-14新增）：對手攻擊時，抽1張道具卡（不看機率，每次受攻擊
    // 都會抽）+20%機率完全閃避，跟pokemon_battle.html同步
    if (defenderAbility?.id === 'bug-sense-dodge' && defender.cur > 0) {
      const hand = G[`${dRole}Hand`];
      const bugSenseDrawn = weightedPick(getDrawPool(defender.type, defender.type2));
      hand.push(bugSenseDrawn);
      G[`${dRole}NeedsDiscard`] = hand.length > 7;
      log.push({ text: `${defender.name} 的蟲之預感發動，抽到了【${bugSenseDrawn.name}】！`, cls: 'special' });
      if (!moldBreaker && damage > 0 && Math.random() < 0.2) {
        damage = 0;
        log.push({ text: `${defender.name} 的蟲之預感發動，完全閃避了攻擊！`, cls: 'special' });
      }
    }
    // 時間咆哮（time-roar，2026-08-14新增，帝牙盧卡專屬）：遊戲中限一次，受到的傷害達到致命
    // （會讓HP歸零）時100%完全迴避，跟pokemon_battle.html同一套「整場戰鬥限一次」旗標寫法
    if (!moldBreaker && damage > 0 && defenderAbility?.id === 'time-roar' && !defender._timeRoarDodgeUsed && damage >= defender.cur) {
      defender._timeRoarDodgeUsed = true;
      damage = 0;
      log.push({ text: `${defender.name} 的時間咆哮發動，完全迴避了致命傷害！（整場戰鬥限一次）`, cls: 'special' });
    }
    defender.cur = Math.max(0, defender.cur - damage);
    // 2026-08-15重新設計：戰鬥盔甲（sturdy，全面替換舊的「HP全滿保留1HP」）——受到攻擊時擲一枚
    // 硬幣，正面反彈50%攻擊傷害給攻擊者，新機制搬到triggerDefenderAbilitySrv（post-hit）
    // 硬殼盔甲（sturdy-half，2026-08-14新增）：跟結實/頑強同一套邏輯，門檻從HP全滿放寬成HP>50%
    if (!moldBreaker && defenderAbility?.id === 'sturdy-half' && wasAboveHalfHp && defender.cur <= 0) {
      defender.cur = 1;
      log.push({ text: `${defender.name} 靠著${defenderAbility.name}保住了 1 HP！`, cls: 'special' });
    }
    // 結實（sturdy-30pct，2026-08-14新增）：門檻改成HP>30%，其餘同sturdy/sturdy-half，每次都可能觸發
    if (!moldBreaker && defenderAbility?.id === 'sturdy-30pct' && wasAboveThirtyPct && defender.cur <= 0) {
      defender.cur = 1;
      log.push({ text: `${defender.name} 靠著${defenderAbility.name}保住了 1 HP！`, cls: 'special' });
    }
    // 毅力／根性（endure-once，2026-08-14新增，共用同一個id）：不限HP門檻，整場戰鬥限一次
    if (!moldBreaker && defenderAbility?.id === 'endure-once' && !defender._enduranceUsed && defender.cur <= 0) {
      defender._enduranceUsed = true;
      defender.cur = 1;
      log.push({ text: `${defender.name} 靠著${defenderAbility.name}保住了 1 HP！（整場戰鬥限一次）`, cls: 'special' });
    }
    // 不屈之心（guts-half-survive，2026-08-14新增）：50%機率、保留10%HP，每次都可能觸發；
    // 「攻擊不會被對手減傷」的部分已經在shieldTerm處理
    if (!moldBreaker && defenderAbility?.id === 'guts-half-survive' && defender.cur <= 0 && Math.random() < 0.5) {
      defender.cur = Math.max(1, Math.floor(defender.hp * 0.1));
      log.push({ text: `${defender.name} 的${defenderAbility.name}發動，保留了 ${defender.cur} HP！`, cls: 'special' });
    }
    // 不動如山（true-damage，2026-08-14從「無視對方特性/閃避/撐住」改成純防禦型「30%機率1HP存活」）
    if (!moldBreaker && defenderAbility?.id === 'true-damage' && defender.cur <= 0 && Math.random() < 0.3) {
      defender.cur = 1;
      log.push({ text: `${defender.name} 的不動如山發動，保住了 1 HP！`, cls: 'special' });
    }
    // 頑強／背水之刃（sudden-death，2026-08-14新增，共用同一個id）：受到致命傷時與對手同歸於盡——
    // 沒有機率字眼，視為必定發動；defender維持死亡狀態不變，額外把attacker也打到0血
    if (!moldBreaker && defenderAbility?.id === 'sudden-death' && defender.cur <= 0 && attacker.cur > 0) {
      attacker.cur = 0;
      log.push({ text: `${defender.name} 的${defenderAbility.name}發動，與${attacker.name} 同歸於盡了！`, cls: 'special' });
    }
    // 激流／猛火（blaze-boost，2026-08-15重新設計）：在原本HP<1/3本系傷害×1.1之上，追加攻擊
    // 附帶回復傷害50%HP的效果
    if (damage > 0 && attackerAbility?.id === 'blaze-boost' && attacker.cur > 0 && !isHealSealedSrv(aRole, G)) {
      const lifestealHeal = Math.min(Math.round(damage * 0.5), attacker.hp - attacker.cur);
      if (lifestealHeal > 0) {
        attacker.cur += lifestealHeal;
        log.push({ text: `${attacker.name} 的${attackerAbility.name}發動，回復了 ${lifestealHeal} HP！`, cls: 'special' });
      }
    }
    // 茂盛（blaze-boost-pure，2026-08-14新增）：攻擊附帶回復傷害50%HP，跟pokemon_battle.html的
    // doAttack同一套處理（isHealSealedSrv封印檢查、命中才觸發）
    if (damage > 0 && attackerAbility?.id === 'blaze-boost-pure' && attacker.cur > 0 && !isHealSealedSrv(aRole, G)) {
      const lifestealHeal = Math.min(Math.round(damage * 0.5), attacker.hp - attacker.cur);
      if (lifestealHeal > 0) {
        attacker.cur += lifestealHeal;
        log.push({ text: `${attacker.name} 的${attackerAbility.name}發動，回復了 ${lifestealHeal} HP！`, cls: 'special' });
      }
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

    if (isAdaptabilityMajor) log.push({ text: `${attacker.name} 的${attackerAbility.name}發動！屬性加成提升為 ×1.4！`, cls: 'super' });
    else if (isAdaptability)  log.push({ text: `${attacker.name} 的適應力發動！屬性加成提升為 ×1.2！`, cls: 'super' });
    else if (stabMult > 1) log.push({ text: `屬性加成！×1.1`, cls: 'super' });
    // 2026-08-14修正：這幾個特性id都已被拆出部分寶可夢分家，剩下共用guts/huge-power/tough-claws
    // 的其他寶可夢名稱各不相同，改用${attackerAbility.name}動態代入，跟pokemon_battle.html同步
    if (attackerAbility?.id === 'huge-power') log.push({ text: `${attacker.name} 的${attackerAbility.name}發動，攻擊威力提升！`, cls: 'super' });
    if (attackerAbility?.id === 'blaze-boost-pure' && lowHpSelf) log.push({ text: `${attacker.name} 瀕危爆發，招式威力大幅提升！`, cls: 'super' });
    if (attackerAbility?.id === 'thick-fat-pure' && lowHpSelf) log.push({ text: `${attacker.name} 瀕危爆發，招式威力大幅提升！`, cls: 'super' });
    if (isBlazeBoostFamily && lowHpSelf && isOwnType) log.push({ text: `${attacker.name} 瀕危爆發，本系招式威力大幅提升！`, cls: 'super' });
    if (attackerAbility?.id === 'tough-claws') log.push({ text: `${attacker.name} 的${attackerAbility.name}發動，攻擊威力提升！`, cls: 'super' });
    if (attackerAbility?.id === 'desperate-blade' && halfHpSelf) log.push({ text: `${attacker.name} 的${attackerAbility.name}發動，攻擊威力提升！`, cls: 'super' });
    if (moldBreaker && defenderAbility && ['thick-fat','solid-rock','frisk-ward','multiscale','sturdy'].includes(defenderAbility.id)) log.push({ text: `${attacker.name} 的${attackerAbility.name}無視了${defender.name}的特性！`, cls: 'super' });
    if (tintedLensProc) log.push({ text: `${attacker.name} 的有色眼鏡發動，抵消了效果不佳！`, cls: 'super' });
    if (thickFatMult < 1) log.push({ text: `${defender.name} 的厚脂肪減輕了傷害！`, cls: 'special' });
    if (solidRockMult < 1) log.push({ text: `${defender.name} 的硬岩減輕了剋制傷害！`, cls: 'special' });
    if (friskWardProc) log.push({ text: `${defender.name} 的神秘之守發動，傷害降低！`, cls: 'special' });
    if (multiscaleMult < 1) log.push({ text: `${defender.name} 的多重鱗片發動，HP全滿時傷害降低！`, cls: 'special' });
    if (thickFatPureReduction > 0) log.push({ text: `${defender.name} 的厚脂肪減輕了傷害！`, cls: 'special' });
    if (solidRockFlatReduction > 0) log.push({ text: `${defender.name} 的硬岩減輕了傷害！`, cls: 'special' });
    if (magicGuardProc) log.push({ text: `${defender.name} 的魔法防守發動，傷害降低！`, cls: 'special' });
    if (mysticGuardHeads) log.push({ text: `${defender.name} 的神秘防守擲出正面，傷害降低！`, cls: 'special' });
    if (cuteCharmProc) log.push({ text: `${defender.name} 的魅力發動，傷害降低！`, cls: 'special' });
    if (mult >= 1.6)        log.push({ text: `超超級有效！(×${mult})`, cls: 'super' });
    else if (mult >= 1.2)   log.push({ text: `超級有效！(×${mult})`, cls: 'super' });
    else if (mult > 0 && mult < 1) log.push({ text: `效果不佳…(×${mult})`, cls: 'resist' });
    log.push({ text: `${attacker.name} 使用了 ${atk.name}，造成 ${damage} 傷害！`, cls: 'attack' });

    // Fire thaws freeze
    if (damage > 0 && atkType === 'fire' && defender.status?.type === 'freeze') {
      defender.status = null;
      log.push({ text: `被火焰融化，${defender.name} 從結凍中解脫！`, cls: 'special' });
    }
    // 熔岩火山：2026-08-13新增，火屬性招式命中造成傷害時，必定讓對手燒傷（招式屬性決定，
    // 不是攻擊方種族屬性，跟pokemon_battle.html的doAttack同一套處理）
    if (damage > 0 && atkType === 'fire' && G.activeStadium?.id === 'stadium-lava' && inflictStatus(G, defender, 'burn', 999)) {
      log.push({ text: `${defender.name} 被熔岩的熱氣灼傷了！`, cls: 'special' });
    }
    if (damage > 0 && atk.selfHeal && attacker.cur > 0 && !isHealSealedSrv(aRole, G)) {
      const heal = Math.round((attacker.hp - attacker.cur) * atk.selfHeal);
      if (heal > 0) {
        attacker.cur = Math.min(attacker.hp, attacker.cur + heal);
        log.push({ text: `${attacker.name} 靠著攻擊回復了 ${heal} HP！`, cls: 'special' });
      }
    }
    // 回復力（recovery-power，2026-08-15新增）：攻擊時，回復本次造成傷害的60%HP
    if (damage > 0 && attackerAbility?.id === 'recovery-power' && attacker.cur > 0 && !isHealSealedSrv(aRole, G)) {
      const heal = Math.round(damage * 0.6);
      if (heal > 0) {
        attacker.cur = Math.min(attacker.hp, attacker.cur + heal);
        log.push({ text: `${attacker.name} 的${attackerAbility.name}發動，回復了 ${heal} HP！`, cls: 'special' });
      }
    }
    // 莊嚴神社：一般屬性攻擊方命中後，回復傷害量10%的HP（原本等同全額傷害太強，2026-08-11調降），
    // 跟pokemon_battle.html的doAttack同一套處理
    if (damage > 0 && (attacker.type === 'normal' || attacker.type2 === 'normal') && G.activeStadium?.id === 'stadium-shrine' && attacker.cur > 0 && !isHealSealedSrv(aRole, G)) {
      const shrineHeal = Math.min(Math.round(damage * 0.1), attacker.hp - attacker.cur);
      if (shrineHeal > 0) {
        attacker.cur += shrineHeal;
        log.push({ text: `${attacker.name} 靠著【莊嚴神社】回復了 ${shrineHeal} HP！`, cls: 'special' });
      }
    }
    // Mega招式效果——rank2抽卡：重用quick-thinking同一套getDrawPool+weightedPick邏輯，
    // 但只抽1張；rank3封鎖對手：重用comm-seal同一個旗標，命中時直接鎖對方下回合的支援者卡。
    // 跟 pokemon_battle.html 的 doAttack 同一處理，見 applyMegaMoveset。
    if (damage > 0 && atk.megaDraw) {
      const hand = G[`${aRole}Hand`];
      const drawn = [weightedPick(getDrawPool(attacker.type, attacker.type2))];
      hand.push(...drawn);
      log.push({ text: `${attacker.name} 的招式效果發動，抽到了：${drawn.map(c => c.name).join('、')}！`, cls: 'special' });
      G[`${aRole}NeedsDiscard`] = hand.length > 7;
    }
    if (damage > 0 && atk.megaSeal) {
      G[`${dRole}SupporterLocked`] = true;
      log.push({ text: `${attacker.name} 的招式效果發動，對方下回合無法使用支援者卡！`, cls: 'special' });
    }
    // 屬性剋制招式（取代原本的輔助技能）：命中時額外附帶效果，讓寶可夢面對不利屬性對局仍有辦法反擊。
    // 跟 pokemon_battle.html 的 doAttack 同一套 rider 邏輯（role/op 對應那邊的 aSide/dSide）。
    if (damage > 0 && atk.rider) {
      switch (atk.rider) {
        case 'energy-steal':
          // 2026-07-31應使用者要求「吸收對手能量的招式感覺可以吸收更多一點」：5/3 → 8/5
          G[`${dRole}Energy`] = Math.max(0, (G[`${dRole}Energy`] || 0) - 8);
          G[`${aRole}Energy`] = Math.min(20, (G[`${aRole}Energy`] || 0) + 5);
          log.push({ text: `${attacker.name} 吸取了對方 8 點能量，自身回復 5 點能量！`, cls: 'special' });
          break;
        case 'guard-up':
          aBuff.shield += 50;
          log.push({ text: `${attacker.name} 順勢架起了護盾，下次受到的攻擊傷害 -50！`, cls: 'special' });
          break;
        case 'card-steal': {
          const opHand = G[`${dRole}Hand`];
          const myHand = G[`${aRole}Hand`];
          if (opHand.length) {
            const idx = Math.floor(Math.random() * opHand.length);
            const stolen = opHand.splice(idx, 1)[0];
            myHand.push(stolen);
            log.push({ text: `${attacker.name} 順勢搶走了對方的【${stolen.name}】！`, cls: 'special' });
            G[`${aRole}NeedsDiscard`] = myHand.length > 7;
          }
          break;
        }
        case 'life-drain': {
          const heal = Math.round(damage * 0.25);
          if (heal > 0 && attacker.cur > 0) {
            attacker.cur = Math.min(attacker.hp, attacker.cur + heal);
            log.push({ text: `${attacker.name} 吸取了 ${heal} HP！`, cls: 'special' });
          }
          break;
        }
        case 'weaken':
          dBuff.atkMult = Math.min(dBuff.atkMult, 0.85);
          log.push({ text: `${attacker.name} 削弱了對方的氣勢，對方下次攻擊傷害 ×0.85！`, cls: 'special' });
          break;
        // 2026-07-27新增4個rider——低消耗（cost<=5）招式的附加效果，跟energy-steal同一套switch
        case 'self-cure':
          if (attacker.status || attacker.status2) {
            const cured = [attacker.status, attacker.status2].filter(Boolean).map(st => STATUS_ZH[st.type] || st.type);
            attacker.status = null;
            attacker.status2 = null;
            log.push({ text: `${attacker.name} 的招式效果發動，解除了${cured.join('、')}！`, cls: 'special' });
          }
          break;
        case 'type-draw': {
          const hand = G[`${aRole}Hand`];
          const pool = TRAINERS.filter(c => c.cat === 'item' && (!c.type || c.type === atk.type));
          const drawn = weightedPick(pool);
          hand.push(drawn);
          log.push({ text: `${attacker.name} 的招式效果發動，抽到了道具卡【${drawn.name}】！`, cls: 'special' });
          G[`${aRole}NeedsDiscard`] = hand.length > 7;
          break;
        }
        case 'move-reflect':
          aBuff.reflect = true;
          log.push({ text: `${attacker.name} 的招式效果發動，架起了反彈鏡！`, cls: 'special' });
          break;
        case 'mega-charge':
          if (!G[`${aRole}MegaUsed`]) {
            G[`${aRole}MegaEnergy`] = Math.min(20, G[`${aRole}MegaEnergy`] + 10);
            log.push({ text: `${attacker.name} 的招式效果發動，Mega 能量 +10！`, cls: 'special' });
          }
          break;
      }
    }
    if (damage > 0) triggerAttackerAbilitySrv(attacker, defender, log, dBuff, G, atkType);
    if (damage > 0) triggerDefenderAbilitySrv(defender, attacker, log, dBuff, G, damage);
  }
  // Inflict status — wrapped so 連擊 (double-strike) can roll it a second time.
  // 2026-07-31新增statusOverride參數：低消耗招式的status2欄位（雙重狀態）也借用同一個閉包
  // 再骰一次，預設仍是atk.status，行為完全不變，只有明確傳入status2時才改骰第二種狀態。
  // 2026-08-01應使用者要求「命中且造成傷害才會骰」改成跟傷害無關——拿掉三處damage>0判斷，
  // 原本盾牌/免疫把傷害壓到0時異常狀態也連帶完全不會骰，容易讓人誤以為機率沒作用。
  const rollStatus = (statusOverride) => {
    const st = statusOverride || atk.status;
    // 妖精結界：接下來N回合，我方上場寶可夢免疫異常狀態
    if (st && defender.cur > 0 && G[`${dRole}StatusImmuneTurns`] > 0) {
      log.push({ text: `${defender.name} 的妖精結界抵擋了異常狀態！`, cls: 'special' });
      return;
    }
    if (st && defender.cur > 0 && defenderAbility?.id === 'status-immune-once' && !defender._temperedHeart) {
      defender._temperedHeart = true;
      log.push({ text: `${defender.name} 的淬鍊之心發動，免疫了異常狀態並提升了攻擊力！`, cls: 'special' });
      return;
    }
    // 心靈感應：下次攻擊的異常狀態機率視為 100%
    // 妖精結界原野：招式自帶的異常狀態機率降低10%（下限0%），guaranteed效果不受影響
    const fairyWardChance1 = G.activeStadium?.id === 'stadium-fairy-ward' ? Math.max(0, (st?.chance || 0) - 0.1) : (st?.chance || 0);
    if (st && defender.cur > 0 && (aBuff.guaranteedStatus || Math.random() < fairyWardChance1)) {
      const effect = st.effect;
      // 盾之王神威（藏瑪然特Mega/劍之王盾之王機制專屬）：完全免疫所有異常狀態，跟own-tempo/insomnia
      // 同樣的「特性直接擋下」寫法，只是不限單一種異常狀態，優先權比鎂光反射更高（直接免疫，不轉嫁）
      if (defenderAbility?.id === 'crowned-shield-aegis') {
        log.push({ text: `${defender.name} 的盾之王神威抵擋了異常狀態！`, cls: 'special' });
      } else if (dBuff.debuffReflect || defenderAbility?.id === 'magic-mirror') {
        // 魔法鏡（magic-mirror，2026-08-14新增）：「反彈受到的負面狀態」直接沿用鎂光反射同一套邏輯，
        // 差別是特性驅動、恆常生效，不是消耗性buff，跟pokemon_battle.html同步
        dBuff.debuffReflect = false;
        if (attacker.cur > 0) {
          const reflectTurns = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                              : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                              : effect === 'freeze'    ? 2
                              : 999;
          if (inflictStatus(G, attacker, effect, reflectTurns)) {
            log.push({ text: `${defender.name} 的鎂光反射將異常狀態彈了回去，${attacker.name} 陷入了${STATUS_ZH[effect]}！`, cls: 'special' });
          } else {
            log.push({ text: `${defender.name} 的鎂光反射彈開了異常狀態！`, cls: 'special' });
          }
        } else {
          log.push({ text: `${defender.name} 的鎂光反射彈開了異常狀態！`, cls: 'special' });
        }
      } else if (defenderAbility?.id === 'own-tempo') {
        // 2026-08-14應使用者要求：我行我素從「只擋混亂」擴大成「不會陷入負面狀態」（任何一種都擋）
        log.push({ text: `${defender.name} 的我行我素抵消了異常狀態！`, cls: 'special' });
      } else if (defenderAbility?.id === 'magic-guard') {
        // 魔法防守（magic-guard，2026-08-14新增：「不會被賦予負面狀態」）：跟own-tempo同一套「完全擋下」寫法
        log.push({ text: `${defender.name} 的魔法防守抵消了異常狀態！`, cls: 'special' });
      } else if (effect === 'sleep' && defenderAbility?.id === 'insomnia') {
        log.push({ text: `${defender.name} 的不眠抵消了睡眠！`, cls: 'special' });
      } else {
        const turnsLeft = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                        : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                        : effect === 'freeze'    ? 2
                        : 999;
        if (!inflictStatus(G, defender, effect, turnsLeft)) {
          log.push({ text: `${defender.name} 異常狀態已達上限，沒有生效。`, cls: 'system' });
          return;
        }
        log.push({ text: `${defender.name} 陷入了${STATUS_ZH[effect]}！`, cls: 'special' });
        // 2026-08-14應使用者要求：同步從「只傳染中毒/麻痺/燒傷」擴大成「任何負面狀態都傳染」——
        // 傳染的turnsLeft重新按效果種類算，不能沿用999
        if (defenderAbility?.id === 'sync-status' && attacker.cur > 0) {
          const syncTurnsLeft = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                              : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                              : effect === 'freeze'    ? 2
                              : 999;
          if (inflictStatus(G, attacker, effect, syncTurnsLeft)) {
            log.push({ text: `${defender.name} 的同步將${STATUS_ZH[effect]}傳染給了${attacker.name}！`, cls: 'special' });
          }
        }
      }
    }
  };
  rollStatus();
  if (aBuff.doubleStrike) rollStatus();
  // 2026-07-31應使用者要求「低傷害招式可以附加雙重狀態」：部分低消耗招式額外帶status2欄位，
  // 命中時再骰一次第二種異常狀態，跟pokemon_battle.html的doAttack同一套處理
  if (atk.status2) rollStatus(atk.status2);
  // 冰霜咆哮：獨立於招式本身異常狀態判定之外的額外40%結凍機率，跟妖精結界/鎂光反射
  // 一樣的免疫判定，但不用own-tempo/insomnia（那兩個只對混亂/睡眠生效，跟結凍無關）
  if (aBuff.iceHowlFreeze && atkType === 'ice' && defender.cur > 0 && !(G[`${dRole}StatusImmuneTurns`] > 0) && Math.random() < 0.4) {
    if (dBuff.debuffReflect) {
      dBuff.debuffReflect = false;
      if (attacker.cur > 0 && inflictStatus(G, attacker, 'freeze', 2)) {
        log.push({ text: `${defender.name} 的鎂光反射將異常狀態彈了回去，${attacker.name} 陷入了結凍！`, cls: 'special' });
      } else {
        log.push({ text: `${defender.name} 的鎂光反射彈開了異常狀態！`, cls: 'special' });
      }
    } else if (inflictStatus(G, defender, 'freeze', 2)) {
      log.push({ text: `${defender.name} 因為冰霜咆哮陷入了結凍！`, cls: 'special' });
    }
  }

  // Consume buffs
  aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFreeType = null; aBuff.costHalved = false; aBuff.ignoreReflectNext = false; aBuff.iceHowlFreeze = false; dBuff.shield = 0; dBuff.iceImmune = false;
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
  G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; G[`${op}Buff`].debuffReflect = false; G[`${op}StandbyGuard`] = false;

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
      if (atk.status && defender.cur > 0 && G[`${op}StatusImmuneTurns`] > 0) {
        log.push({ text: `${defender.name} 的妖精結界抵擋了異常狀態！`, cls: 'special' });
        break;
      }
      if (atk.status && defender.cur > 0 && defender.ability?.id === 'status-immune-once' && !defender._temperedHeart) {
        defender._temperedHeart = true;
        log.push({ text: `${defender.name} 的淬鍊之心發動，免疫了異常狀態並提升了攻擊力！`, cls: 'special' });
        break;
      }
      // 妖精結界原野：招式自帶的異常狀態機率降低10%（下限0%），guaranteed效果不受影響
      const fairyWardChance2 = G.activeStadium?.id === 'stadium-fairy-ward' ? Math.max(0, (atk.status?.chance || 0) - 0.1) : (atk.status?.chance || 0);
      if (atk.status && defender.cur > 0 && (guaranteed || Math.random() < fairyWardChance2)) {
        const effect = atk.status.effect;
        if (defender.ability?.id === 'crowned-shield-aegis') {
          log.push({ text: `${defender.name} 的盾之王神威抵擋了異常狀態！`, cls: 'special' });
        } else if (defender.ability?.id === 'own-tempo') {
          log.push({ text: `${defender.name} 的我行我素抵消了異常狀態！`, cls: 'special' });
        } else if (defender.ability?.id === 'magic-guard') {
          log.push({ text: `${defender.name} 的魔法防守抵消了異常狀態！`, cls: 'special' });
        } else if (effect === 'sleep' && defender.ability?.id === 'insomnia') {
          log.push({ text: `${defender.name} 的不眠抵消了睡眠！`, cls: 'special' });
        } else {
          const turnsLeft = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                          : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                          : effect === 'freeze'    ? 2
                          : 999;
          if (inflictStatus(G, defender, effect, turnsLeft)) {
            log.push({ text: `${defender.name} 陷入了${STATUS_ZH[effect]}！`, cls: 'special' });
          } else {
            log.push({ text: `${defender.name} 異常狀態已達上限，沒有生效。`, cls: 'system' });
          }
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
      aBuff.atkBonus = 40;
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
    // 2026-08-13重新設計：從「最大HP 25%」改成固定100傷害
    const dmg = Math.min(poke.cur, 100);
    poke.cur = Math.max(0, poke.cur - dmg); // 扣血效果應該能讓寶可夢陣亡，不該保留1HP
    log.push({ text: `${poke.name} 受到了尖峰陷阱的傷害！（-${dmg} HP）`, cls: 'special' });
  }
  if (G.activeStadium?.id === 'stadium-toxic-field' && inflictStatus(G, poke, 'poison', 999)) {
    log.push({ text: `${poke.name} 踏入了劇毒領域，陷入了中毒！`, cls: 'special' });
  }
}
// Ability hooks — no-op for Pokémon without `ability` (see project memory for full list)
// `isFieldEntry=false` for in-place transforms (瘋狂博士/Mega 進化) — those never "switch in"
// from the bench, so trap stadiums (which punish entering the field) shouldn't fire for them.
// 2026-07-24應使用者要求「四招太像，想拉開差距」重新設計，跟 pokemon_battle.html 的
// 同名函式邏輯一致——真正的「2弱2強」成本/威力梯度 + 四招各自的額外手感（見下方註解）。
// 2026-08-01應使用者回報「傷害整體被拉太高了」調整：base招式改成「威力落在50~150
// 依cost線性內插」，Mega進化後招式一併壓到合理範圍（比base高一些作為回饋），跟
// pokemon_battle.html的applyMegaMoveset同步（完整說明見該檔案同一行）。
// 2026-08-01再次應使用者要求「50~150還是太高」下修：base範圍改成40~110，Mega區間
// 跟著等比例下修（維持「比base高一些」的回饋關係，不是照抄base數字）
const MEGA_MOVESET_RANGE = { 1: [50, 120], 2: [55, 130], 3: [60, 140] };
const MEGA_MOVESET_COSTS = [3, 5, 6, 7];
// rank3（最強招）沒有內建異常狀態時，依招式屬性補一個——沿用TRAINERS道具卡片
// 已經在用的同一套屬性↔異常對應（fire-bomb→燒傷／gas-attack→中毒／confuse-potion→混亂／
// absolute-zero→結凍／paralyze-trap→麻痺），不是另外發明新的對應規則。
const MEGA_TYPE_STATUS = { fire: 'burn', poison: 'poison', psychic: 'confusion', ice: 'freeze', electric: 'paralysis' };
function applyMegaMoveset(poke) {
  const [rangeLo, rangeHi] = MEGA_MOVESET_RANGE[poke.tier] || MEGA_MOVESET_RANGE[2];
  const order = poke.attacks.map((a, i) => i).sort((a, b) => poke.attacks[a].dmg - poke.attacks[b].dmg);
  order.forEach((moveIdx, rank) => {
    const move = poke.attacks[moveIdx];
    const cost = MEGA_MOVESET_COSTS[rank];
    const frac = (cost - MEGA_MOVESET_COSTS[0]) / (MEGA_MOVESET_COSTS[3] - MEGA_MOVESET_COSTS[0]);
    const jitter = ((poke.id * 13 + rank * 7) % 11) - 5; // -5..+5
    move.dmg = Math.max(rangeLo, Math.min(rangeHi, Math.round(rangeLo + frac * (rangeHi - rangeLo) + jitter)));
    move.cost = cost;
    // 2026-07-25應使用者要求，把rank2/rank3原本的「提高異常機率」換成使用者一開始就
    // 點名的「抽卡」「封鎖對手」——重用quick-thinking（抽卡）/comm-seal（鎖支援者卡）
    // 這兩張既有道具卡的同一套邏輯，只是改成招式命中時觸發，見doAttack裡
    // `atk.megaDraw`/`atk.megaSeal`的處理。rank0/rank1維持能量/回血不變。
    if (rank === 0) {
      move.bonusEnergy = 5;
    } else if (rank === 1) {
      move.selfHeal = 0.2;
    } else if (rank === 2) {
      move.megaDraw = true;
    } else {
      move.megaSeal = true;
      if (move.status) move.status = { ...move.status, chance: Math.max(move.status.chance, 0.65) };
      else if (MEGA_TYPE_STATUS[move.type]) move.status = { effect: MEGA_TYPE_STATUS[move.type], chance: 0.35 };
    }
  });
}
// 2026-08-13重新設計：羅馬鬥技場(fighting)/亡靈墓園(ghost)/魔幻空間(psychic)三張場地卡共用
// 同一套「雙重攻擊」機制（原本只有羅馬鬥技場一張，第二次傷害從×0.5改成×0.4），attack handler
// 裡的PendingColosseumHit邏輯改成查這張表，不是寫死colosseum
const STADIUM_DOUBLE_ATTACK = {
  'stadium-colosseum':    'fighting',
  'stadium-ghost-curse':  'ghost',
  'stadium-mystic-space': 'psychic',
};
// 場地卡閃避機率表（2026-08-13重新設計）——doAttack()裡的stadiumDodgeProc查這張表
const STADIUM_DODGE = {
  'stadium-flying-wind': { types: ['flying'], chance: 0.5 },
  'stadium-toxic-field': { types: ['poison'], chance: 0.2 },
  'stadium-sandstorm':   { types: ['ground', 'rock'], chance: 0.7 },
  'stadium-bug-hive':    { types: ['bug'], chance: 0.5 },
};
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
  // 2026-07-23新增：8張新場地卡對應的8個新領域特性id
  'electric-domain': { stadium: 'stadium-electric-storm', type: 'electric' },
  'ice-domain':      { stadium: 'stadium-ice-tundra',      type: 'ice' },
  'dark-domain':     { stadium: 'stadium-dark-curse',      type: 'dark' },
  'steel-domain':    { stadium: 'stadium-steel-fortress',  type: 'steel' },
  'flying-domain':   { stadium: 'stadium-flying-wind',     type: 'flying' },
  'bug-domain':      { stadium: 'stadium-bug-hive',        type: 'bug' },
  'ghost-domain':    { stadium: 'stadium-ghost-curse',     type: 'ghost' },
  'fairy-domain':    { stadium: 'stadium-fairy-ward',      type: 'fairy' },
};
// 2026-08-08修正：獵捕(hunt)跟single-player同一個bug/同一套修法，見pokemon_battle.html的
// triggerOnEnter說明——isFieldEntry=false只擋trap，Mega進化那處也傳false但要特性繼續發動，
// 兩個呼叫點需求相反，新增獨立的suppressAbility參數
function triggerOnEnterSrv(poke, role, G, log, isFieldEntry = true, suppressAbility = false) {
  if (isFieldEntry) triggerTrapStadiumSrv(poke, role, G, log);
  if (suppressAbility) return;
  if (!poke?.ability || isAbilitySealedSrv(role, G)) return;
  const op = role === 'p1' ? 'p2' : 'p1';
  if (poke.ability.id === 'intimidate') {
    const opBuff = G[`${op}Buff`];
    // 2026-08-14應使用者要求：從×0.9下修到×0.5，跟pokemon_battle.html的triggerOnEnter同步
    opBuff.atkMult = Math.min(opBuff.atkMult, 0.5);
    log.push({ text: `${poke.name} 的威嚇讓對方下次攻擊傷害 ×0.5！`, cls: 'special' });
  }
  // 2026-08-15重新設計：緊張感（pressure，全面替換舊的「上場-3能量」）——上場時擲一枚硬幣，
  // 正面對手棄兩張手牌，對手沒手牌可棄則改成直接扣血
  if (poke.ability.id === 'pressure') {
    const heads = Math.random() < 0.5;
    if (heads) {
      const opHand = G[`${op}Hand`];
      if (opHand.length > 0) {
        const n = Math.min(2, opHand.length);
        for (let i = 0; i < n; i++) opHand.splice(Math.floor(Math.random() * opHand.length), 1);
        log.push({ text: `${poke.name} 的緊張感擲出正面，讓對方棄掉了 ${n} 張手牌！`, cls: 'special' });
      } else {
        const opDeck = G[`${op}Deck`]; const opIdx = G[`${op}Idx`];
        const opPoke = opDeck?.[opIdx];
        if (opPoke) {
          opPoke.cur = Math.max(0, opPoke.cur - 50);
          log.push({ text: `${poke.name} 的緊張感擲出正面，對方沒有手牌可棄，${opPoke.name} 直接受到 50 點傷害！`, cls: 'special' });
        }
      }
    } else {
      log.push({ text: `${poke.name} 的緊張感擲出反面，沒有發生任何事。`, cls: 'special' });
    }
  }
  // 威壓氣場（weaken-buffs，2026-08-15重新設計）：上場時對手能量歸零，並讓對手下一次攻擊傷害-50
  if (poke.ability.id === 'weaken-buffs') {
    const opBuff = G[`${op}Buff`];
    G[`${op}Energy`] = 0;
    opBuff.atkBonus = Math.min(opBuff.atkBonus, -50);
    log.push({ text: `${poke.name} 的威壓氣場發動，讓對方能量歸零、下一次攻擊傷害 -50！`, cls: 'special' });
  }
  // 妖精氣場／妖精領域（fairy-aura-field，2026-08-15新增）：上場時場地切換為妖精結界原野，並回復8點能量
  if (poke.ability.id === 'fairy-aura-field') {
    if (!spaceCutBlocksSrv(G, role)) {
      const fairyCard = TRAINERS.find(c => c.id === 'stadium-fairy-ward');
      if (fairyCard) {
        G.activeStadium = { ...fairyCard };
        log.push({ text: `${poke.name} 的${poke.ability.name}發動，場地切換成了妖精結界原野！`, cls: 'special' });
      }
    }
    G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 8);
    log.push({ text: `${poke.name} 的${poke.ability.name}發動，額外獲得了 8 點能量！`, cls: 'special' });
  }
  // 德爾塔氣流（delta-stream，2026-08-15新增）：上場時場地切換為疾風之翼；場地鎖定的部分見
  // applyTrainer的場地啟用分支，那裡會檢查G.deltaStreamLockSide
  if (poke.ability.id === 'delta-stream') {
    if (!spaceCutBlocksSrv(G, role)) {
      const windCard = TRAINERS.find(c => c.id === 'stadium-flying-wind');
      if (windCard) {
        G.activeStadium = { ...windCard };
        log.push({ text: `${poke.name} 的德爾塔氣流發動，場地切換成了疾風之翼！`, cls: 'special' });
      }
    }
    G.deltaStreamLockSide = role;
  }
  // 終結之地（terminus，2026-08-15新增）：上場時清掉場地效果，並棄掉雙方手牌
  if (poke.ability.id === 'terminus') {
    if (G.activeStadium) {
      const clearedName = G.activeStadium.name;
      G.activeStadium = null;
      log.push({ text: `${poke.name} 的終結之地發動，清除了【${clearedName}】的競技場效果！`, cls: 'special' });
    }
    if (G.p1Hand.length) { log.push({ text: `終結之地讓玩家1棄掉了全部 ${G.p1Hand.length} 張手牌！`, cls: 'special' }); G.p1Hand = []; }
    if (G.p2Hand.length) { log.push({ text: `終結之地讓玩家2棄掉了全部 ${G.p2Hand.length} 張手牌！`, cls: 'special' }); G.p2Hand = []; }
  }
  // 熾熱核心（scorching-core，2026-08-15新增）：上場時，將對手燒傷，並棄掉對手兩張手牌
  if (poke.ability.id === 'scorching-core') {
    const opDeck = G[`${op}Deck`]; const opIdx = G[`${op}Idx`];
    const opPoke = opDeck?.[opIdx];
    if (opPoke && opPoke.cur > 0 && inflictStatus(G, opPoke, 'burn', 999)) {
      log.push({ text: `${poke.name} 的熾熱核心讓 ${opPoke.name} 陷入了燒傷！`, cls: 'special' });
    }
    const opHand = G[`${op}Hand`];
    const n = Math.min(2, opHand.length);
    if (n > 0) {
      for (let i = 0; i < n; i++) opHand.splice(Math.floor(Math.random() * opHand.length), 1);
      log.push({ text: `${poke.name} 的熾熱核心讓對方棄掉了 ${n} 張手牌！`, cls: 'special' });
    }
  }
  // 惡夢（nightmare-curse）／暗影（shadow-curse，2026-08-15新增）：上場時賦予對手睡眠，暗影再額外棄1張手牌
  if (poke.ability.id === 'nightmare-curse' || poke.ability.id === 'shadow-curse') {
    const opDeck = G[`${op}Deck`]; const opIdx = G[`${op}Idx`];
    const opPoke = opDeck?.[opIdx];
    if (opPoke && opPoke.cur > 0 && inflictStatus(G, opPoke, 'sleep', 999)) {
      log.push({ text: `${poke.name} 的${poke.ability.name}讓 ${opPoke.name} 陷入了睡眠！`, cls: 'special' });
    }
    if (poke.ability.id === 'shadow-curse') {
      const opHand = G[`${op}Hand`];
      if (opHand.length) {
        opHand.splice(Math.floor(Math.random() * opHand.length), 1);
        log.push({ text: `${poke.name} 的暗影讓對方棄掉了一張手牌！`, cls: 'special' });
      }
    }
  }
  // 恆淨之軀（purity-body，2026-08-15新增）：上場時清掉場地+封印對手特性1回合；回合開始的重複
  // 觸發見drawForRole
  if (poke.ability.id === 'purity-body') {
    if (G.activeStadium) {
      const clearedName = G.activeStadium.name;
      G.activeStadium = null;
      log.push({ text: `${poke.name} 的恆淨之軀發動，清除了【${clearedName}】的競技場效果！`, cls: 'special' });
    }
    const opSealKey = `${op}AbilitySealedTurns`;
    G[opSealKey] = Math.max(G[opSealKey] || 0, 1);
    log.push({ text: `${poke.name} 的恆淨之軀發動，封印了對方的特性！`, cls: 'special' });
  }
  // 惡作劇之心（mischief-heart，2026-08-15新增）：上場時與回合結束時，將雙方手牌交換
  if (poke.ability.id === 'mischief-heart') {
    [G.p1Hand, G.p2Hand] = [G.p2Hand, G.p1Hand];
    log.push({ text: `${poke.name} 的惡作劇之心發動，雙方的手牌交換了！`, cls: 'special' });
    G.p1NeedsDiscard = G.p1Hand.length > 7;
    G.p2NeedsDiscard = G.p2Hand.length > 7;
  }
  // 2026-08-14新增：壓迫感（pressure-drain，從pressure分家）——上場時-5能量（原本-3上修），
  // 且「對手每回合回復的能量-3」是只要這隻寶可夢還在場上就持續的效果（不是onEnter一次性），
  // 實際扣減發生在turn-start能量回復區塊，這裡只處理onEnter的-5部分，跟pokemon_battle.html同步
  if (poke.ability.id === 'pressure-drain') {
    const drain = Math.min(5, G[`${op}Energy`] || 0);
    G[`${op}Energy`] = Math.max(0, (G[`${op}Energy`] || 0) - 5);
    log.push({ text: `${poke.name} 的壓迫感讓對方損失了 ${drain} 點能量！`, cls: 'special' });
  }
  // 反骨（retaliate-boost，2026-08-14新增）：上場時+5能量，回合開始的部分見drawForRole
  if (poke.ability.id === 'retaliate-boost') {
    G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 5);
    log.push({ text: `${poke.name} 的反骨發動，額外獲得了 5 點能量！`, cls: 'special' });
  }
  // 超幸運（super-luck-draw，2026-08-14新增）：上場時50%機率額外抽2張道具卡，回合開始的部分見drawForRole
  if (poke.ability.id === 'super-luck-draw' && Math.random() < 0.5) {
    const hand = G[`${role}Hand`];
    const drawn = [weightedPick(getDrawPool(poke.type, poke.type2)), weightedPick(getDrawPool(poke.type, poke.type2))];
    hand.push(...drawn);
    log.push({ text: `${poke.name} 的超幸運發動，額外抽到了：${drawn.map(c => c.name).join('、')}！`, cls: 'special' });
    G[`${role}NeedsDiscard`] = hand.length > 7;
  }
  // 魅力（cute-charm-confuse，2026-08-14新增）：上場時讓對手陷入混亂（必定觸發），受到攻擊40%機率
  // 減傷的部分已在doAttack的cuteCharmMult處理
  if (poke.ability.id === 'cute-charm-confuse') {
    const opPoke = G[`${op}Deck`]?.[G[`${op}Idx`]];
    if (opPoke && opPoke.cur > 0 && inflictStatus(G, opPoke, 'confusion', Math.floor(Math.random() * 3) + 2)) {
      log.push({ text: `${poke.name} 的魅力發動，讓${opPoke.name} 陷入了混亂！`, cls: 'special' });
    }
  }
  // 2026-08-14重新設計：複製（trace）從「複製對手當前特性」改成「獲得對手上回合使用過的道具卡」——
  // G[op+'LastItemPlayed']由use_trainer handler在打出道具卡時更新，見那裡的說明
  if (poke.ability.id === 'trace') {
    const lastItem = G[`${op}LastItemPlayed`];
    if (lastItem) {
      const hand = G[`${role}Hand`];
      hand.push({ ...lastItem });
      log.push({ text: `${poke.name} 的複製發動，獲得了對手上回合使用過的【${lastItem.name}】！`, cls: 'special' });
      G[`${role}NeedsDiscard`] = hand.length > 7;
    }
  }
  // 2026-08-14新增：靜電（static-paralyze-dual，從static分家）上場時必定麻痺對手；攻擊附帶
  // 電屬性傷害的「擇優計算」部分已經在doAttack的mult覆蓋處理，這裡只處理onEnter麻痺
  if (poke.ability.id === 'static-paralyze-dual') {
    const opPoke = G[`${op}Deck`]?.[G[`${op}Idx`]];
    if (opPoke && opPoke.cur > 0 && inflictStatus(G, opPoke, 'paralysis', 999)) {
      log.push({ text: `${poke.name} 的靜電發動，讓${opPoke.name} 陷入了麻痺！`, cls: 'special' });
    }
  }
  // 2026-08-14新增：以下所有特性驅動的自動場地切換，都要先檢查對面是不是空間切割（帕路奇亞）
  // 持有者——「對手不能發動競技場（包含對手特性也不行）」，跟pokemon_battle.html同步
  // 2026-08-14新增：電氣場地（shock-stadium-dodge，從motor-drive分家）上場時場地切換為雷雲庇護所；
  // 20%完全閃避的部分已經在doAttack的閃避段落處理，這裡只處理onEnter場地切換
  // （曾短暫加過「手動卡片優先於特性自動切換」的規則，同日被使用者收回——正確規則是
  // 單純「後發生的蓋掉先發生的」，不分卡片或特性）
  if (poke.ability.id === 'shock-stadium-dodge' && !spaceCutBlocksSrv(G, role)) {
    const stormCard = TRAINERS.find(c => c.id === 'stadium-electric-storm');
    if (stormCard) {
      G.activeStadium = { ...stormCard };
      log.push({ text: `${poke.name} 的電氣場地發動，場地切換成了雷雲庇護所！`, cls: 'special' });
    }
  }
  // 揚沙（sandstorm-stadium-dodge，2026-08-14新增）：跟電氣場地同一套onEnter場地切換寫法，改成沙塵暴
  if (poke.ability.id === 'sandstorm-stadium-dodge' && !spaceCutBlocksSrv(G, role)) {
    const sandCard = TRAINERS.find(c => c.id === 'stadium-sandstorm');
    if (sandCard) {
      G.activeStadium = { ...sandCard };
      log.push({ text: `${poke.name} 的揚沙發動，場地切換成了沙塵暴！`, cls: 'special' });
    }
  }
  // 反轉世界（reverse-world-dodge，2026-08-14新增，騎拉帝納專屬）：同一套onEnter場地切換寫法，改成反轉世界
  if (poke.ability.id === 'reverse-world-dodge' && !spaceCutBlocksSrv(G, role)) {
    const invertCard = TRAINERS.find(c => c.id === 'stadium-invert');
    if (invertCard) {
      G.activeStadium = { ...invertCard };
      log.push({ text: `${poke.name} 的反轉世界發動，場地切換成了反轉世界！`, cls: 'special' });
    }
  }
  // 空間切割（space-cut，2026-08-14修正：「受到攻擊時可棄場地卡換-50」改成「上場時清除競技場效果」）：
  // 帕路奇亞上場時，不論當前競技場卡是誰發動的，直接清空G.activeStadium
  if (poke.ability.id === 'space-cut' && G.activeStadium) {
    const clearedName = G.activeStadium.name;
    G.activeStadium = null;
    log.push({ text: `${poke.name} 的空間切割發動，清除了【${clearedName}】的競技場效果！`, cls: 'special' });
  }
  // 2026-08-14新增：毒療（poison-heal）上場時自動陷入中毒——跳過機率/免疫判定，之後每回合
  // 回復量在applyEndOfTurnStatusSrv那邊改成固定70，跟pokemon_battle.html同步
  if (poke.ability.id === 'poison-heal' && poke.cur > 0) {
    if (inflictStatus(G, poke, 'poison', 999)) {
      log.push({ text: `${poke.name} 的毒療發動，自動陷入了中毒！`, cls: 'special' });
    }
  }
  if (poke.ability.id === 'drizzle-ocean' && !spaceCutBlocksSrv(G, role)) {
    const oceanCard = TRAINERS.find(c => c.id === 'stadium-ocean');
    if (oceanCard) {
      G.activeStadium = { ...oceanCard };
      log.push({ text: `${poke.name} 的海洋支配發動，場地切換成了海洋世界！`, cls: 'special' });
    }
  }
  if (poke.ability.id === 'drought-lava' && !spaceCutBlocksSrv(G, role)) {
    const lavaCard = TRAINERS.find(c => c.id === 'stadium-lava');
    if (lavaCard) {
      G.activeStadium = { ...lavaCard };
      log.push({ text: `${poke.name} 的熔岩大地發動，場地切換成了熔岩火山！`, cls: 'special' });
    }
  }
  if (DOMAIN_ABILITY_STADIUM[poke.ability.id] && !spaceCutBlocksSrv(G, role)) {
    const domainCard = TRAINERS.find(c => c.id === DOMAIN_ABILITY_STADIUM[poke.ability.id].stadium);
    if (domainCard) {
      G.activeStadium = { ...domainCard };
      log.push({ text: `${poke.name} 的${poke.ability.name}發動，場地切換成了${domainCard.name}！`, cls: 'special' });
    }
  }
}

// 「寶可夢離場時觸發」的通用hook。2026-08-15：指揮（legacy-boost）全面改成onDefend觸發
// （見triggerDefenderAbilitySrv），不再需要onLeave，目前沒有任何特性使用這個hook，保留空殼
// 供未來需要「離場觸發」的特性使用，跟pokemon_battle.html同步。
function triggerOnLeaveSrv(poke, role, G, log) {
  if (!poke?.ability) return;
}

function triggerAttackerAbilitySrv(attacker, defender, log, dBuff, G, atkType) {
  const aRole = dBuff === G.p1Buff ? 'p2' : 'p1'; // dBuff is the defender's buff, so attacker is the other role
  const dRole = aRole === 'p1' ? 'p2' : 'p1';
  if (!attacker.ability || isAbilitySealedSrv(aRole, G)) return;
  if (attacker.ability.id === 'static-trail' && defender.cur > 0 && Math.random() < 0.15 && inflictStatus(G, defender, 'paralysis', 999)) {
    log.push({ text: `${attacker.name} 的電擊尾隨讓 ${defender.name} 陷入了麻痺！`, cls: 'special' });
  }
  // 穿透（penetrate，2026-08-15重新設計）：攻擊完後，會再造成70傷害（無條件）
  if (attacker.ability.id === 'penetrate' && defender.cur > 0) {
    defender.cur = Math.max(0, defender.cur - 70);
    log.push({ text: `${attacker.name} 的穿透發動，讓 ${defender.name} 額外受到了 70 點傷害！`, cls: 'special' });
  }
  // 崩潰（guts，2026-08-15重新設計）：自身帶有異常狀態攻擊時擲一枚硬幣，正面與對手同歸於盡
  if (attacker.ability.id === 'guts' && attacker.status && attacker.cur > 0) {
    if (Math.random() < 0.5) {
      attacker.cur = 0;
      defender.cur = 0;
      log.push({ text: `${attacker.name} 的${attacker.ability.name}擲出正面，與 ${defender.name} 同歸於盡！`, cls: 'special' });
    } else {
      log.push({ text: `${attacker.name} 的${attacker.ability.name}擲出反面，沒有發生任何事。`, cls: 'special' });
    }
  }
  // 電鰻升格／火鬃（elemental-purge，2026-08-15新增）：使用本系攻擊時，棄掉對手兩張手牌
  if (attacker.ability.id === 'elemental-purge' && (atkType === attacker.type || atkType === attacker.type2)) {
    const opHand = G[`${dRole}Hand`];
    const n = Math.min(2, opHand.length);
    if (n > 0) {
      for (let i = 0; i < n; i++) opHand.splice(Math.floor(Math.random() * opHand.length), 1);
      log.push({ text: `${attacker.name} 的${attacker.ability.name}發動，讓對方棄掉了 ${n} 張手牌！`, cls: 'special' });
    }
  }
  if (attacker.ability.id === 'chance-debuff' && defender.cur > 0 && Math.random() < 0.25) {
    dBuff.atkMult = Math.min(dBuff.atkMult, 0.9);
    log.push({ text: `${attacker.name} 的穿透讓對方下次攻擊傷害 ×0.9！`, cls: 'special' });
  }
  // 強壯之顎（dark-jaw-discard，2026-08-14新增）：攻擊後30%棄掉對手一張手牌
  if (attacker.ability.id === 'dark-jaw-discard' && Math.random() < 0.3) {
    const opHand = G[`${aRole === 'p1' ? 'p2' : 'p1'}Hand`];
    if (opHand.length) {
      const idx = Math.floor(Math.random() * opHand.length);
      const discarded = opHand.splice(idx, 1)[0];
      log.push({ text: `${attacker.name} 的強壯之顎發動，讓對方棄掉了【${discarded.name}】！`, cls: 'special' });
    }
  }
}

function triggerDefenderAbilitySrv(defender, attacker, log, dBuff, G, damage = 0) {
  const dRole = dBuff === G.p1Buff ? 'p1' : 'p2';
  if (!defender.ability || isAbilitySealedSrv(dRole, G)) return;
  if (defender.ability.id === 'static' && Math.random() < 0.20 && inflictStatus(G, attacker, 'paralysis', 999)) {
    log.push({ text: `${defender.name} 的靜電讓 ${attacker.name} 陷入了麻痺！`, cls: 'special' });
  } else if (defender.ability.id === 'legacy-boost') {
    // 2026-08-15重新設計：指揮，全面替換舊的「離場時留給下一隻」——受到攻擊後，標記下個我方
    // 回合開始時：抽兩張道具卡+這回合攻擊傷害+50（見drawForRole開頭的消耗處）
    G[`${dRole}CommandPending`] = true;
    log.push({ text: `${defender.name} 的${defender.ability.name}發動，下個回合將額外抽牌並提升攻擊威力！`, cls: 'special' });
  } else if (defender.ability.id === 'sturdy') {
    // 2026-08-15重新設計：戰鬥盔甲（全面替換）——受到攻擊時擲一枚硬幣，正面反彈50%攻擊傷害給攻擊者
    if (Math.random() < 0.5) {
      const reflectDmg = Math.round(damage * 0.5);
      attacker.cur = Math.max(0, attacker.cur - reflectDmg);
      log.push({ text: `${defender.name} 的${defender.ability.name}擲出正面，反彈了 ${reflectDmg} 點傷害給 ${attacker.name}！`, cls: 'special' });
    } else {
      log.push({ text: `${defender.name} 的${defender.ability.name}擲出反面，沒有發生任何事。`, cls: 'special' });
    }
  } else if (defender.ability.id === 'frozen-body' && inflictStatus(G, attacker, 'freeze', 999)) {
    log.push({ text: `${defender.name} 的${defender.ability.name}讓 ${attacker.name} 陷入了結凍！`, cls: 'special' });
    if (!spaceCutBlocksSrv(G, dRole)) {
      const iceCard = TRAINERS.find(c => c.id === 'stadium-ice-tundra');
      if (iceCard) {
        G.activeStadium = { ...iceCard };
        log.push({ text: `${defender.name} 的冰凍之軀將場地切換成了永凍冰原！`, cls: 'special' });
      }
    }
  } else if (defender.ability.id === 'ice-skin' && inflictStatus(G, attacker, 'freeze', 999)) {
    log.push({ text: `${defender.name} 的${defender.ability.name}讓 ${attacker.name} 陷入了結凍！`, cls: 'special' });
  } else if (defender.ability.id === 'fairy-skin' && inflictStatus(G, attacker, 'confusion', 999)) {
    log.push({ text: `${defender.name} 的${defender.ability.name}讓 ${attacker.name} 陷入了混亂！`, cls: 'special' });
  } else if (defender.ability.id === 'rough-skin') {
    const recoil = Math.max(1, Math.floor(attacker.hp / 8));
    attacker.cur = Math.max(0, attacker.cur - recoil);
    log.push({ text: `${defender.name} 的粗糙皮膚反彈了 ${recoil} 點傷害給 ${attacker.name}！`, cls: 'special' });
  } else if (defender.ability.id === 'poison-point' && Math.random() < 0.20 && inflictStatus(G, attacker, 'poison', 999)) {
    log.push({ text: `${defender.name} 的毒刺讓 ${attacker.name} 陷入了中毒！`, cls: 'special' });
  } else if (defender.ability.id === 'flame-body' && Math.random() < 0.20 && inflictStatus(G, attacker, 'burn', 999)) {
    log.push({ text: `${defender.name} 的火焰之軀讓 ${attacker.name} 陷入了燒傷！`, cls: 'special' });
    if (!spaceCutBlocksSrv(G, dRole)) {
      const lavaCard = TRAINERS.find(c => c.id === 'stadium-lava');
      if (lavaCard) {
        G.activeStadium = { ...lavaCard };
        log.push({ text: `${defender.name} 的火焰之軀將場地切換成了熔岩火山！`, cls: 'special' });
      }
    }
  } else if (defender.ability.id === 'toxic-debris' && defender.cur > 0 && attacker.cur > 0) {
    // 毒素碎片（toxic-debris，2026-08-14新增）：受到攻擊後，固定50傷害+必定中毒（不是機率）
    const recoil = Math.min(50, attacker.cur);
    attacker.cur = Math.max(0, attacker.cur - recoil);
    const poisoned = inflictStatus(G, attacker, 'poison', 999);
    log.push({ text: `${defender.name} 的毒素碎片發動，對 ${attacker.name} 造成了 ${recoil} 點傷害${poisoned ? '，並讓對方中毒了' : ''}！`, cls: 'special' });
  }
}

// Applies a trainer card effect to the given role's side.
// 2026-08-15新增：「使用卡牌時／使用道具卡時」觸發的特性，跟pokemon_battle.html的
// triggerCardUseAbility同一套邏輯，在applyTrainer最前面呼叫一次。
function triggerCardUseAbilitySrv(card, role, G, log) {
  const op = role === 'p1' ? 'p2' : 'p1';
  const active = G[`${role}Deck`]?.[G[`${role}Idx`]];
  if (!active?.ability || isAbilitySealedSrv(role, G) || active.cur <= 0) return;
  const opActive = G[`${op}Deck`]?.[G[`${op}Idx`]];
  if (active.ability.id === 'technician') {
    G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 5);
    G[`${op}Energy`] = Math.max(0, (G[`${op}Energy`] || 0) - 5);
    log.push({ text: `${active.name} 的技術高手發動，回復了5點能量、讓對方損失了5點能量！`, cls: 'special' });
  }
  if (active.ability.id === 'mega-launcher' && opActive && opActive.cur > 0) {
    opActive.cur = Math.max(0, opActive.cur - 50);
    log.push({ text: `${active.name} 的${active.ability.name}發動，讓 ${opActive.name} 受到了 50 點傷害！`, cls: 'special' });
  }
  if (active.ability.id === 'heavy-armor' && card.cat === 'item') {
    const buff = G[`${role}Buff`];
    buff.shield = (buff.shield || 0) + 30;
    log.push({ text: `${active.name} 的${active.ability.name}發動，獲得了 30 點減傷（可以疊加）！`, cls: 'special' });
  }
  if (active.ability.id === 'acceleration' && card.cat === 'item') {
    G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 5);
    const counterKey = `${role}AccelerationEnergyThisTurn`;
    G[counterKey] = (G[counterKey] || 0) + 5;
    log.push({ text: `${active.name} 的加速發動，額外獲得了 5 點能量！`, cls: 'special' });
    if (G[counterKey] > 8) {
      const buff = G[`${role}Buff`];
      buff.atkBonus = Math.max(buff.atkBonus, 40);
      log.push({ text: `${active.name} 的加速發動，這回合使用能量超過8點，下次攻擊威力 +40！`, cls: 'special' });
    }
  }
  if (active.ability.id === 'healing-heart' && card.cat === 'item' && active.cur < active.hp && !isHealSealedSrv(role, G)) {
    const heal = Math.min(Math.round(active.hp * 0.2), active.hp - active.cur);
    if (heal > 0) {
      active.cur += heal;
      log.push({ text: `${active.name} 的治癒之心發動，回復了 ${heal} HP！`, cls: 'special' });
    }
  }
}
function applyTrainer(card, role, G, log, chosenType) {
  const op     = role === 'p1' ? 'p2' : 'p1';
  const deck   = G[`${role}Deck`];
  const idx    = G[`${role}Idx`];
  const buff   = G[`${role}Buff`];
  const active = deck[idx];
  const attackTypes = Object.keys(EFF);
  triggerCardUseAbilitySrv(card, role, G, log);

  // 德爾塔氣流（delta-stream，2026-08-15新增）：持有者還在場上（不限主戰/板凳）時，場地卡只能
  // 被清除，不能被覆蓋——這裡直接檢查「當下持有者是否仍活著」而不是靠專門清旗標
  if (card.cat === 'stadium' && G.deltaStreamLockSide) {
    const lockSideDeck = G[`${G.deltaStreamLockSide}Deck`];
    const lockHolderAlive = lockSideDeck.some(p => p.ability?.id === 'delta-stream' && p.cur > 0);
    if (lockHolderAlive) {
      log.push({ text: `想發動【${card.name}】，但德爾塔氣流讓場地無法被覆蓋！`, cls: 'special' });
      return;
    }
    G.deltaStreamLockSide = null;
  }

  // 顛倒之心（contrary-heart，2026-08-14新增）：雙方打出的卡牌效果都反過來——用「執行前後
  // 快照差異」取代逐張手動判斷每張卡該不該反轉，跟pokemon_battle.html的applyTrainer同一套邏輯
  const contraryHeartActiveForCard = (!isAbilitySealedSrv('p1', G) && G.p1Deck[G.p1Idx]?.ability?.id === 'contrary-heart' && G.p1Deck[G.p1Idx]?.cur > 0)
    || (!isAbilitySealedSrv('p2', G) && G.p2Deck[G.p2Idx]?.ability?.id === 'contrary-heart' && G.p2Deck[G.p2Idx]?.cur > 0);
  const cardSnapshot = contraryHeartActiveForCard ? {
    p1Cur: G.p1Deck[G.p1Idx]?.cur ?? 0,
    p2Cur: G.p2Deck[G.p2Idx]?.cur ?? 0,
    p1Energy: G.p1Energy,
    p2Energy: G.p2Energy,
    p1AtkBonus: G.p1Buff.atkBonus,
    p1AtkMult: G.p1Buff.atkMult,
    p2AtkBonus: G.p2Buff.atkBonus,
    p2AtkMult: G.p2Buff.atkMult,
  } : null;
  // 精神力（mind-power，2026-08-15新增）：全面免疫對手的卡牌效果——跟顛倒之心同一套「執行前後
  // 快照，事後還原」寫法，但只還原持有者自己的HP/異常狀態，且只在打卡的是對方時才生效。
  // 已知範圍限制：場地卡的環境效果沒有走applyTrainer，這裡涵蓋不到，跟pokemon_battle.html同步。
  const mindPowerRole = (!isAbilitySealedSrv(op, G) && G[`${op}Deck`]?.[G[`${op}Idx`]]?.ability?.id === 'mind-power' && G[`${op}Deck`]?.[G[`${op}Idx`]]?.cur > 0) ? op : null;
  const mindPowerSnapshot = mindPowerRole ? {
    cur: G[`${mindPowerRole}Deck`]?.[G[`${mindPowerRole}Idx`]]?.cur ?? 0,
    status: G[`${mindPowerRole}Deck`]?.[G[`${mindPowerRole}Idx`]]?.status ?? null,
    status2: G[`${mindPowerRole}Deck`]?.[G[`${mindPowerRole}Idx`]]?.status2 ?? null,
  } : null;

  switch (card.id) {
    case 'potion-m': case 'potion-l': case 'potion-xl': {
      if (isHealSealedSrv(role, G)) { log.push({ text: `使用了${card.name}，但恢復效果被詛咒封印中，沒有任何效果！`, cls: 'system' }); break; }
      const healAmt = { 'potion-m':40, 'potion-l':60, 'potion-xl':80 }[card.id];
      active.cur = Math.min(active.hp, active.cur + healAmt);
      log.push({ text: `使用了${card.name}，${active.name} 回復 ${healAmt} HP！`, cls: 'system' });
      break;
    }
    case 'x-atk':
      buff.atkBonus = 40;
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
    case 'antidote': {
      // 2026-08-13重新設計：從「亡靈墓園全擋」改成用isStatusCureBlockedSrv逐格檢查
      // （劇毒領域只擋中毒、熔岩火山只擋燒傷、亡靈墓園仍是全擋）
      const slot1Blocked = active.status && isStatusCureBlockedSrv(G, active.status.type);
      const slot2Blocked = active.status2 && isStatusCureBlockedSrv(G, active.status2.type);
      if (!active.status && !active.status2) break;
      const cured = [];
      if (active.status && !slot1Blocked) { cured.push(STATUS_ZH[active.status.type] || active.status.type); active.status = null; }
      if (active.status2 && !slot2Blocked) { cured.push(STATUS_ZH[active.status2.type] || active.status2.type); active.status2 = null; }
      if (cured.length) {
        log.push({ text: `萬能藥解除了 ${active.name} 的${cured.join('、')}！${(slot1Blocked || slot2Blocked) ? '（部分異常狀態被場地效果封印，無法解除）' : ''}`, cls: 'system' });
      } else {
        log.push({ text: `異常狀態被場地效果封印，無法解除！`, cls: 'system' });
      }
      break;
    }
    case 'nurse': {
      const slot1Blocked = active.status && isStatusCureBlockedSrv(G, active.status.type);
      const slot2Blocked = active.status2 && isStatusCureBlockedSrv(G, active.status2.type);
      const anyBlocked = slot1Blocked || slot2Blocked;
      if (isHealSealedSrv(role, G)) {
        if (!slot1Blocked) active.status = null;
        if (!slot2Blocked) active.status2 = null;
        log.push({ text: anyBlocked ? `部分異常狀態被場地效果封印，恢復效果也被詛咒封印！` : `治療師解除了 ${active.name} 的異常狀態，但恢復效果被詛咒封印中，HP 沒有回復！`, cls: 'system' });
      } else {
        active.cur = active.hp;
        if (!slot1Blocked) active.status = null;
        if (!slot2Blocked) active.status2 = null;
        log.push({ text: `治療師讓 ${active.name} 完全回復HP${anyBlocked ? '，但部分異常狀態被場地效果封印，無法解除' : ''}！`, cls: 'system' });
      }
      break;
    }
    case 'all-out':
      buff.atkMult *= 1.2;
      G[`${role}EnergyBlockedNextTurn`] = true;
      log.push({ text: `使用了全力出擊，下次攻擊傷害 ×1.2！但下回合無法回復能量！`, cls: 'system' });
      break;
    case 'fire-bomb': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (inflictStatus(G, opActive, 'burn', 999)) { log.push({ text: `火焰彈讓 ${opActive.name} 陷入燒傷！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，火焰彈無效！`, cls: 'system' });
      break;
    }
    case 'gas-attack': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (inflictStatus(G, opActive, 'poison', 999)) { log.push({ text: `瓦斯攻擊讓 ${opActive.name} 陷入中毒！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，瓦斯攻擊無效！`, cls: 'system' });
      break;
    }
    case 'confuse-potion': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (opActive.ability?.id === 'own-tempo') { log.push({ text: `${opActive.name} 的我行我素抵消了混亂藥！`, cls: 'system' }); }
      else if (inflictStatus(G, opActive, 'confusion', Math.floor(Math.random()*3)+2)) { log.push({ text: `混亂藥讓 ${opActive.name} 陷入混亂！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，混亂藥無效！`, cls: 'system' });
      break;
    }
    case 'absolute-zero': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (inflictStatus(G, opActive, 'freeze', 2)) { log.push({ text: `絕對零度讓 ${opActive.name} 陷入結凍！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，絕對零度無效！`, cls: 'system' });
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
        G[`${opRole}StandbyGuard`] = false;
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
    case 'rune-revelation': {
      // 無視反彈鏡的部分沿用ignoreReflectNext（跟招式版ignoreReflect分開，見doAttack註解），沒打出去
      // 就跟其他攻擊buff一樣在回合結束時失效；搏命免疫是獨立旗標，存在G[role+'RuneShield']，不放進buff
      // 避免被doAttack每次攻擊後的buff reset清掉。2026-08-01應使用者要求「效果應該一回合就要結束」，
      // 額外記錄授予當下的G.round到G[role+'RuneShieldRound']，檢查時（sacrifice分支）只認「這回合或
      // 下一回合內」授予的免疫，避免像之前那樣一路殘留到好幾回合後才被搏命打中還能擋下來
      buff.ignoreReflectNext = true;
      G[`${role}RuneShield`] = true;
      G[`${role}RuneShieldRound`] = G.round;
      log.push({ text: `使用了盧恩啟示，下次攻擊將無視對方反彈鏡，並免疫下一次搏命效果！`, cls: 'system' });
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
      if (inflictStatus(G, opActive, 'paralysis', 999)) { log.push({ text: `電擊誘餌讓 ${opActive.name} 陷入麻痺！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，電擊誘餌無效！`, cls: 'system' });
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
      active.status2 = null;
      const gain = Math.min(40, active.hp - active.cur);
      active.cur = Math.min(active.hp, active.cur + 40);
      log.push({ text: `使用了妖精之光，${active.name} 解除異常狀態並回復了 ${gain} HP！`, cls: 'system' });
      break;
    }
    case 'swarm-sting': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      const before = G[`${op}Energy`];
      G[`${op}Energy`] = Math.max(0, G[`${op}Energy`] - 3);
      if (inflictStatus(G, opActive, 'poison', 999)) { log.push({ text: `群聚針刺讓 ${opActive.name} 陷入中毒，並損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，群聚針刺只讓對方損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'system' });
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
      buff.atkBonus = 40;
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
      buff.atkBonus = bonus;
      log.push({ text: `使用了背水一戰，HP 越低加成越高，下次攻擊威力 +${bonus}！`, cls: 'system' });
      break;
    }
    case 'double-strike':
      // 2026-07-22應使用者要求：原本×1.08倍率太弱，改成固定+40傷害；doubleStrike(狀態機率×2)本身不受影響
      buff.atkBonus = 40;
      buff.doubleStrike = true;
      log.push({ text: `使用了連擊，下次攻擊威力 +40，並將分兩段結算！`, cls: 'system' });
      break;
    case 'energy-patch-l': {
      const gain = 8;
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
      buff.atkBonus = 60;
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (Math.random() < 0.3 && inflictStatus(G, opActive, 'burn', 999)) {
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
      buff.costFreeType = 'electric';
      log.push({ text: `使用了${card.name}，下次電屬性寶可夢或電屬性招式攻擊不消耗能量！`, cls: 'system' });
      break;
    case 'leech-seed':
      G[`${role}LeechTurns`] = 3;
      log.push({ text: `使用了${card.name}，接下來 3 回合，每回合開始都會吸取對方 3 點能量！`, cls: 'special' });
      break;
    case 'mind-focus': {
      buff.guaranteedStatus = true;
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (opActive.ability?.id === 'insomnia') {
        log.push({ text: `使用了${card.name}，下次攻擊的異常狀態機率視為 100%！但${opActive.name} 的不眠抵消了睡眠！`, cls: 'system' });
      } else if (inflictStatus(G, opActive, 'sleep', 1)) {
        log.push({ text: `使用了${card.name}，下次攻擊的異常狀態機率視為 100%，${opActive.name} 也陷入了 1 回合的睡眠！`, cls: 'system' });
      } else {
        log.push({ text: `使用了${card.name}，下次攻擊的異常狀態機率視為 100%！（${opActive.name} 異常狀態已達上限，睡眠沒有生效）`, cls: 'system' });
      }
      break;
    }
    case 'breakthrough':
      buff.atkBonus = 40;
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
    case 'fairy-barrier': {
      G[`${role}StatusImmuneTurns`] = 2;
      // 2026-07-29新增：妖精屬性寶可夢額外回復5%最大HP
      const isFairyMon = active.type === 'fairy' || active.type2 === 'fairy';
      if (isFairyMon && !isHealSealedSrv(role, G)) {
        const heal = Math.min(Math.round(active.hp * 0.05), active.hp - active.cur);
        active.cur = Math.min(active.hp, active.cur + Math.round(active.hp * 0.05));
        log.push({ text: `使用了${card.name}，接下來 2 回合免疫異常狀態！${active.name} 是妖精屬性，額外回復了 ${heal} HP！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，接下來 2 回合，我方上場寶可夢免疫異常狀態！`, cls: 'special' });
      }
      break;
    }
    case 'toxic-pact': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 10);
      if (inflictStatus(G, opActive, 'poison', 999)) {
        log.push({ text: `使用了${card.name}，讓${opActive.name} 陷入中毒，並損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，${opActive.name} 異常狀態已達上限，只損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'system' });
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
        buff.atkBonus = 70;
        log.push({ text: `使用了${card.name}，對手已有異常狀態，下次攻擊威力 +70！`, cls: 'special' });
      } else {
        buff.atkBonus = 25;
        log.push({ text: `使用了${card.name}，下次攻擊威力 +25！`, cls: 'special' });
      }
      break;
    }
    case 'fire-resolve': {
      // 2026-07-29應使用者要求：原本「下回合開始損失15能量」的代價改成「立即損失60 HP」，
      // 並且如果使用的寶可夢不是火屬性，還會讓自己陷入燒傷——floor在1，自傷不會直接KO
      active.cur = Math.max(1, active.cur - 60);
      buff.atkMult = Math.max(buff.atkMult, 1.3);
      const isFireMon = active.type === 'fire' || active.type2 === 'fire';
      let msg = `使用了${card.name}，下次攻擊威力 ×1.3，但 ${active.name} 損失了 60 HP！`;
      if (!isFireMon && inflictStatus(G, active, 'burn', 999)) {
        msg += `因為不是火屬性，自己也陷入了燒傷！`;
      }
      log.push({ text: msg, cls: 'special' });
      break;
    }
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
      if (Math.random() < 0.4 && inflictStatus(G, opActive, 'paralysis', 999)) {
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
        buff.atkBonus = 80;
        log.push({ text: `使用了${card.name}，對手已有異常狀態，下次攻擊威力 +80！`, cls: 'special' });
      } else {
        buff.atkBonus = 50;
        log.push({ text: `使用了${card.name}，下次攻擊威力 +50！`, cls: 'special' });
      }
      break;
    }
    case 'fighting-crush': {
      const opBuff = G[`${op}Buff`];
      if (opBuff.shield > 0) {
        buff.atkBonus = 90;
        log.push({ text: `使用了${card.name}，對手持有防禦加成，下次攻擊威力 +90！`, cls: 'special' });
      } else {
        buff.atkBonus = 60;
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
        buff.atkBonus = 40;
        log.push({ text: `使用了${card.name}，下次攻擊異常狀態機率 100%，對手為 Mega 型態，威力額外 +40！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，下次攻擊異常狀態機率視為 100%！`, cls: 'special' });
      }
      break;
    }
    case 'dragon-fang':
      // 2026-07-23應使用者要求：原本-10點能量副作用太傷，改成-5
      G[`${role}Energy`] = Math.max(0, (G[`${role}Energy`] || 0) - 5);
      buff.atkBonus = 90;
      log.push({ text: `使用了${card.name}，損失 5 點能量，下次攻擊威力 +90！`, cls: 'special' });
      break;
    case 'dragon-cleanse': {
      if (active.status || active.status2) {
        const cured = [active.status, active.status2].filter(Boolean).map(st => STATUS_ZH[st.type] || st.type);
        active.status = null;
        active.status2 = null;
        log.push({ text: `使用了${card.name}，解除了 ${active.name} 的${cured.join('、')}！`, cls: 'special' });
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
      buff.shield += 40;
      buff.debuffReflect = true;
      log.push({ text: `使用了${card.name}，下次承受傷害 -40，且對手下次施放的負面效果會反彈回對手自己身上！`, cls: 'special' });
      break;
    }
    case 'ice-howl':
      // 2026-07-29應使用者要求：原本「立即35%機率讓對手結凍」改成「下次攻擊若為冰屬性，
      // 傷害×1.2，並額外有40%機率附加結凍」——傷害倍率沿用既有的typeBoost機制，結凍
      // 另外用iceHowlFreeze旗標，在doAttack裡的主異常狀態判定之外獨立骰一次
      buff.typeBoost = { type: 'ice', mult: 1.2 };
      buff.iceHowlFreeze = true;
      log.push({ text: `使用了${card.name}，下次冰屬性攻擊威力 ×1.2，並額外有 40% 機率附加結凍！`, cls: 'special' });
      break;
    case 'ice-barrier':
      buff.shield += 40;
      // 這張卡在施放者自己回合中設定，但保護的是「對方下一次攻擊」，跟ability-seal那種在自己
      // 回合設定、影響「被封印方自己接下來N回合」的情境不同：drawForRole把op的封印倒數放在
      // role回合開始時扣，這張卡的op要等到對方下一次真的攻擊時才會讀到——中間剛好差一次
      // drawForRole，存1在對方回合開始就會被扣成0，來不及生效一次，需要存2才能撐過。
      G[`${role}StatusImmuneTurns`] = Math.max(G[`${role}StatusImmuneTurns`] || 0, 2);
      log.push({ text: `使用了${card.name}，下次承受傷害 -40，接下來 1 回合免疫異常狀態！`, cls: 'special' });
      break;
    case 'normal-allout':
      buff.atkBonus = 35;
      buff.costFreeType = 'normal';
      log.push({ text: `使用了${card.name}，下次攻擊威力 +35，一般屬性寶可夢或一般屬性招式攻擊不消耗能量！`, cls: 'special' });
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
      buff.atkBonus = 50;
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
        buff.atkBonus = 80;
        log.push({ text: `使用了${card.name}，場上有競技場效果，下次攻擊威力 +80！`, cls: 'special' });
      } else {
        buff.atkBonus = 55;
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
      } else if (Math.random() < 0.3 && inflictStatus(G, opActive, 'confusion', Math.floor(Math.random() * 3) + 2)) {
        log.push({ text: `使用了${card.name}，${opActive.name} 陷入了混亂！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，但沒有觸發效果。`, cls: 'system' });
      }
      break;
    }
    case 'fairy-heal': {
      if (active.status || active.status2) {
        const cured = [active.status, active.status2].filter(Boolean).map(st => STATUS_ZH[st.type] || st.type);
        active.status = null;
        active.status2 = null;
        log.push({ text: `使用了${card.name}，解除了 ${active.name} 的${cured.join('、')}！`, cls: 'special' });
      }
      const gain = Math.min(active.hp - active.cur, 10);
      active.cur = Math.min(active.hp, active.cur + gain);
      break;
    }
    case 'poison-spore': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (Math.random() < 0.5 && inflictStatus(G, opActive, 'poison', 999)) {
        log.push({ text: `使用了${card.name}，${opActive.name} 陷入了中毒！`, cls: 'special' });
      } else {
        log.push({ text: `使用了${card.name}，但沒有觸發效果。`, cls: 'system' });
      }
      break;
    }
    case 'poison-strike': {
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if (opActive.status?.type === 'poison' || opActive.status2?.type === 'poison') {
        buff.atkBonus = 80;
        log.push({ text: `使用了${card.name}，對手已中毒，下次攻擊威力 +80！`, cls: 'special' });
      } else {
        buff.atkBonus = 40;
        log.push({ text: `使用了${card.name}，下次攻擊威力 +40！`, cls: 'special' });
      }
      break;
    }
    case 'bug-web': {
      const before = G[`${op}Energy`] || 0;
      G[`${op}Energy`] = Math.max(0, before - 6);
      buff.atkBonus = 20;
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
    case 'stadium-dragon-valley':
    case 'stadium-evil-forest':
    case 'stadium-mega-prism':
    case 'stadium-toxic-field':
    case 'stadium-colosseum':
    case 'stadium-lava':
    case 'stadium-ocean':
    case 'stadium-shrine':
    case 'stadium-sandstorm':
    case 'stadium-rock-field':
    case 'stadium-electric-storm':
    case 'stadium-ice-tundra':
    case 'stadium-dark-curse':
    case 'stadium-steel-fortress':
    case 'stadium-flying-wind':
    case 'stadium-bug-hive':
    case 'stadium-ghost-curse': {
      const old = G.activeStadium;
      G.activeStadium = card;
      if (old) log.push({ text: `新競技場【${card.name}】取代了【${old.name}】！`, cls: 'special' });
      else log.push({ text: `【${card.name}】競技場開場！`, cls: 'special' });
      break;
    }
    // 2026-08-13重新設計：以下4張場地卡發動當下還有額外的一次性效果，跟其餘場地卡共用的
    // 「純粹切換G.activeStadium」case分開處理
    case 'stadium-invert': {
      const old = G.activeStadium;
      G.activeStadium = card;
      if (old) log.push({ text: `新競技場【${card.name}】取代了【${old.name}】！`, cls: 'special' });
      else log.push({ text: `【${card.name}】競技場開場！`, cls: 'special' });
      // 發動時，雙方手牌互換
      const tmp = G.p1Hand; G.p1Hand = G.p2Hand; G.p2Hand = tmp;
      log.push({ text: `反轉世界讓雙方的手牌互換了！`, cls: 'special' });
      G.p1NeedsDiscard = G.p1Hand.length > 7;
      G.p2NeedsDiscard = G.p2Hand.length > 7;
      break;
    }
    case 'stadium-spikes': {
      const old = G.activeStadium;
      G.activeStadium = card;
      if (old) log.push({ text: `新競技場【${card.name}】取代了【${old.name}】！`, cls: 'special' });
      else log.push({ text: `【${card.name}】競技場開場！`, cls: 'special' });
      // 發動時，對手棄掉2張手牌
      const opHand = G[`${op}Hand`];
      const discardedNames = [];
      for (let i = 0; i < 2 && opHand.length; i++) {
        const idx2 = Math.floor(Math.random() * opHand.length);
        discardedNames.push(opHand.splice(idx2, 1)[0].name);
      }
      if (discardedNames.length) log.push({ text: `尖峰陷阱讓對手棄掉了【${discardedNames.join('】【')}】！`, cls: 'special' });
      break;
    }
    case 'stadium-mystic-space': {
      const old = G.activeStadium;
      G.activeStadium = card;
      if (old) log.push({ text: `新競技場【${card.name}】取代了【${old.name}】！`, cls: 'special' });
      else log.push({ text: `【${card.name}】競技場開場！`, cls: 'special' });
      // 發動時，若我方場上寶可夢是超屬性寶可夢，可搶奪對方一張卡牌
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      if ((active.type === 'psychic' || active.type2 === 'psychic') && opActive.cur > 0) {
        const opHand = G[`${op}Hand`];
        if (opHand.length) {
          const idx2 = Math.floor(Math.random() * opHand.length);
          const stolen = opHand.splice(idx2, 1)[0];
          G[`${role}Hand`].push(stolen);
          log.push({ text: `魔幻空間發動，搶走了對方的【${stolen.name}】！`, cls: 'special' });
          G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;
        }
      }
      break;
    }
    case 'stadium-fairy-ward': {
      const old = G.activeStadium;
      G.activeStadium = card;
      if (old) log.push({ text: `新競技場【${card.name}】取代了【${old.name}】！`, cls: 'special' });
      else log.push({ text: `【${card.name}】競技場開場！`, cls: 'special' });
      // 發動時，妖精寶可夢解除負面狀態
      const opActive = G[`${op}Deck`][G[`${op}Idx`]];
      [active, opActive].forEach(poke => {
        if (poke.cur > 0 && (poke.type === 'fairy' || poke.type2 === 'fairy') && (poke.status || poke.status2)) {
          poke.status = null; poke.status2 = null;
          log.push({ text: `妖精結界原野發動，${poke.name} 的負面狀態解除了！`, cls: 'special' });
        }
      });
      break;
    }
  }

  // 顛倒之心（contrary-heart，2026-08-14新增）：卡片執行完後，比對快照算出這張卡真正造成的
  // 淨變化，把每個追蹤欄位的變化量減掉（等於把淨效果反過來），跟pokemon_battle.html同一套邏輯
  if (cardSnapshot) {
    const p1Deck = G.p1Deck[G.p1Idx];
    const p2Deck = G.p2Deck[G.p2Idx];
    const dP1Cur = (p1Deck ? p1Deck.cur : cardSnapshot.p1Cur) - cardSnapshot.p1Cur;
    const dP2Cur = (p2Deck ? p2Deck.cur : cardSnapshot.p2Cur) - cardSnapshot.p2Cur;
    const dP1Energy = G.p1Energy - cardSnapshot.p1Energy;
    const dP2Energy = G.p2Energy - cardSnapshot.p2Energy;
    const dP1AtkBonus = G.p1Buff.atkBonus - cardSnapshot.p1AtkBonus;
    const dP2AtkBonus = G.p2Buff.atkBonus - cardSnapshot.p2AtkBonus;
    const dP1AtkMult = G.p1Buff.atkMult - cardSnapshot.p1AtkMult;
    const dP2AtkMult = G.p2Buff.atkMult - cardSnapshot.p2AtkMult;
    if (dP1Cur || dP2Cur || dP1Energy || dP2Energy || dP1AtkBonus || dP2AtkBonus || dP1AtkMult || dP2AtkMult) {
      if (p1Deck) p1Deck.cur = Math.max(0, Math.min(p1Deck.hp, cardSnapshot.p1Cur - dP1Cur));
      if (p2Deck) p2Deck.cur = Math.max(0, Math.min(p2Deck.hp, cardSnapshot.p2Cur - dP2Cur));
      G.p1Energy = Math.max(0, Math.min(20, cardSnapshot.p1Energy - dP1Energy));
      G.p2Energy = Math.max(0, Math.min(20, cardSnapshot.p2Energy - dP2Energy));
      G.p1Buff.atkBonus = cardSnapshot.p1AtkBonus - dP1AtkBonus;
      G.p2Buff.atkBonus = cardSnapshot.p2AtkBonus - dP2AtkBonus;
      G.p1Buff.atkMult = Math.max(0.1, cardSnapshot.p1AtkMult - dP1AtkMult);
      G.p2Buff.atkMult = Math.max(0.1, cardSnapshot.p2AtkMult - dP2AtkMult);
      log.push({ text: `顛倒之心發動，${card.name}的效果反過來了！`, cls: 'special' });
    }
  }
  // 精神力（mind-power）：卡片執行完後，把持有者的HP/異常狀態還原成打卡前的樣子
  if (mindPowerSnapshot) {
    const mpDeck = G[`${mindPowerRole}Deck`][G[`${mindPowerRole}Idx`]];
    const changed = mpDeck.cur !== mindPowerSnapshot.cur || mpDeck.status !== mindPowerSnapshot.status || mpDeck.status2 !== mindPowerSnapshot.status2;
    if (changed) {
      mpDeck.cur = mindPowerSnapshot.cur;
      mpDeck.status = mindPowerSnapshot.status;
      mpDeck.status2 = mindPowerSnapshot.status2;
      log.push({ text: `${mpDeck.name} 的精神力發動，完全不受對手卡牌效果影響！`, cls: 'special' });
    }
  }
}

// Draws 1-2 cards for a single role at the start of their turn.
// Also applies Hot Springs healing (once per turn, for both sides).
function drawForRole(G, role) {
  // 蓄電（charge，2026-08-15新增）：回合開始時先把「上個我方回合有沒有攻擊」拍照存起來
  // （doAttack本體會設AttackedLastOwnTurn=true），再重置旗標讓這回合重新計算
  G[`${role}ChargeReady`] = !G[`${role}AttackedLastOwnTurn`];
  G[`${role}AttackedLastOwnTurn`] = false;
  // 指揮（legacy-boost，2026-08-15重新設計）：上回合受到攻擊留下的標記，這回合開始時消耗——
  // 抽兩張道具卡+這回合攻擊傷害+50
  if (G[`${role}CommandPending`]) {
    const roleActiveForCommand = G[`${role}Deck`]?.[G[`${role}Idx`]];
    if (roleActiveForCommand && roleActiveForCommand.cur > 0) {
      G[`${role}CommandPending`] = false;
      const pool = getDrawPool(roleActiveForCommand.type, roleActiveForCommand.type2);
      const drawnCmd = [weightedPick(pool), weightedPick(pool)];
      G[`${role}Hand`].push(...drawnCmd);
      G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;
      G[`${role}Buff`].atkBonus = Math.max(G[`${role}Buff`].atkBonus, 50);
    }
  }
  // 通訊封印：把「下回合鎖定」的旗標升級成「這回合鎖定中」，並清掉原始旗標——
  // 這樣鎖定只會卡住緊接著的這一回合，之後的回合不會被誤鎖
  G[`${role}SupporterLockedThisTurn`] = G[`${role}SupporterLocked`];
  G[`${role}SupporterLocked`] = false;
  G[`${role}UsedItemThisTurn`] = false; // 機械之心系特性的旗標，每回合開始重置
  G[`${role}AccelerationEnergyThisTurn`] = 0; // 加速特性的旗標，每回合開始重置
  G[`${role}ItemsPlayedThisTurn`] = []; // 時間咆哮（time-roar）用的累積清單，每回合開始重置（讀取見下方）
  G[`${role}StadiumTradeCount`] = 0; // 棄1張換競技場卡的每回合上限，這裡是該角色回合真正開始的地方
  // op提前到這裡宣告（原本在下面宣告一次）——2026-08-13新增的op/role場地卡效果需要在這裡就用到，
  // op＝這次turn transition剛結束回合的那一方，role＝現在要開始回合的那一方
  const op = role === 'p1' ? 'p2' : 'p1';
  // 訓練場：回合結束時，該回合玩家（op）額外抽取一張支援者卡
  if (G.activeStadium?.id === 'stadium-training' && G[`${op}Deck`][G[`${op}Idx`]].cur > 0) {
    G[`${op}Hand`].push(pickSupporterAvoidingDupes(G[`${op}Hand`]));
  }
  if (G.activeStadium?.id === 'stadium-spring') {
    const opPoke = G[`${op}Deck`][G[`${op}Idx`]];
    if (opPoke.cur > 0) {
      if (opPoke.cur < opPoke.hp && !isHealSealedSrv(op, G)) {
        opPoke.cur = Math.min(opPoke.hp, opPoke.cur + 70);
      }
      G[`${op}Hand`].push(pickSupporterAvoidingDupes(G[`${op}Hand`]));
    }
  }
  // 逆轉鬥技場：回合結束時，該回合玩家（op）回復150HP
  if (G.activeStadium?.id === 'stadium-reversal') {
    const opPoke = G[`${op}Deck`][G[`${op}Idx`]];
    if (opPoke.cur > 0 && !isHealSealedSrv(op, G)) {
      opPoke.cur = Math.min(opPoke.hp, opPoke.cur + 150);
    }
  }
  // 海洋世界：回合結束時，該回合玩家（op）回復30HP
  if (G.activeStadium?.id === 'stadium-ocean') {
    const opPoke = G[`${op}Deck`][G[`${op}Idx`]];
    if (opPoke.cur > 0 && !isHealSealedSrv(op, G)) {
      opPoke.cur = Math.min(opPoke.hp, opPoke.cur + 30);
    }
  }
  // 沙塵暴：非地面／岩石／鋼屬性寶可夢，該回合結束的一方（op）損失50HP，
  // 即將開始回合的一方（role）損失20HP——同一次turn transition裡兩邊各觸發各自的量
  if (G.activeStadium?.id === 'stadium-sandstorm') {
    [{ r: op, dmg: 50 }, { r: role, dmg: 20 }].forEach(({ r, dmg }) => {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      const immune = ['ground', 'rock', 'steel'].includes(poke.type) || ['ground', 'rock', 'steel'].includes(poke.type2);
      if (poke.cur > 0 && !immune) {
        poke.cur = Math.max(0, poke.cur - Math.min(poke.cur, dmg));
      }
    });
  }
  // 永凍冰原：回合結束時，即將開始回合的一方（role，也就是op的對手）若為非冰屬性則被結凍
  if (G.activeStadium?.id === 'stadium-ice-tundra') {
    const rolePoke = G[`${role}Deck`][G[`${role}Idx`]];
    if (rolePoke.cur > 0 && rolePoke.type !== 'ice' && rolePoke.type2 !== 'ice') {
      inflictStatus(G, rolePoke, 'freeze', 2);
    }
  }
  // 邪惡森林：每回合結束，草屬性上場寶可夢回復70HP，跟stadium-spring同一套寫法（雙方對稱）
  if (G.activeStadium?.id === 'stadium-evil-forest') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur > 0 && poke.cur < poke.hp && (poke.type === 'grass' || poke.type2 === 'grass') && !isHealSealedSrv(r, G)) {
        poke.cur = Math.min(poke.hp, poke.cur + 70);
      }
    }
  }
  // 莊嚴神社：每回合結束，一般屬性上場寶可夢回復70HP，跟stadium-evil-forest同一套寫法（雙方對稱）
  if (G.activeStadium?.id === 'stadium-shrine') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur > 0 && poke.cur < poke.hp && (poke.type === 'normal' || poke.type2 === 'normal') && !isHealSealedSrv(r, G)) {
        poke.cur = Math.min(poke.hp, poke.cur + 70);
      }
    }
  }
  // 暗夜詛咒領域：若場上（任一方）為惡屬性寶可夢，回合結束時，該側的對手棄掉1張手牌
  if (G.activeStadium?.id === 'stadium-dark-curse') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur <= 0 || !(poke.type === 'dark' || poke.type2 === 'dark')) continue;
      const opOfR = r === 'p1' ? 'p2' : 'p1';
      const opHand = G[`${opOfR}Hand`];
      if (opHand.length) {
        const idx = Math.floor(Math.random() * opHand.length);
        opHand.splice(idx, 1);
      }
    }
  }
  // 魔幻空間：回合結束時，若我方（任一方）場上寶可夢是超屬性寶可夢，可搶奪對方一張卡牌
  if (G.activeStadium?.id === 'stadium-mystic-space') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur <= 0 || !(poke.type === 'psychic' || poke.type2 === 'psychic')) continue;
      const opOfR = r === 'p1' ? 'p2' : 'p1';
      const opHand = G[`${opOfR}Hand`];
      if (opHand.length) {
        const idx = Math.floor(Math.random() * opHand.length);
        const stolen = opHand.splice(idx, 1)[0];
        G[`${r}Hand`].push(stolen);
        G[`${r}NeedsDiscard`] = G[`${r}Hand`].length > 7;
      }
    }
  }
  // 妖精結界原野：回合開始時，即將開始回合的一方（role）若為妖精屬性，解除負面狀態；
  // 回合結束時，即將開始回合的一方（role，也就是op的對手）獲得混亂
  if (G.activeStadium?.id === 'stadium-fairy-ward') {
    const rolePoke = G[`${role}Deck`][G[`${role}Idx`]];
    if (rolePoke.cur > 0) {
      if ((rolePoke.type === 'fairy' || rolePoke.type2 === 'fairy') && (rolePoke.status || rolePoke.status2)) {
        rolePoke.status = null; rolePoke.status2 = null;
      }
      inflictStatus(G, rolePoke, 'confusion', Math.floor(Math.random() * 3) + 2);
    }
  }
  // 惡夢／暗影（nightmare-curse/shadow-curse，2026-08-15新增）：回合結束時（op剛結束回合）重複觸發
  // 上場時同樣的睡眠(+暗影棄牌)效果。drawForRole沒有log參數，這裡是靜默的state mutation
  {
    const opPoke2 = G[`${op}Deck`]?.[G[`${op}Idx`]];
    const rolePoke2 = G[`${role}Deck`]?.[G[`${role}Idx`]];
    if (opPoke2 && (opPoke2.ability?.id === 'nightmare-curse' || opPoke2.ability?.id === 'shadow-curse') && opPoke2.cur > 0 && !isAbilitySealedSrv(op, G)) {
      if (rolePoke2 && rolePoke2.cur > 0) inflictStatus(G, rolePoke2, 'sleep', 999);
      if (opPoke2.ability.id === 'shadow-curse') {
        const roleHand2 = G[`${role}Hand`];
        if (roleHand2.length) roleHand2.splice(Math.floor(Math.random() * roleHand2.length), 1);
      }
    }
    // 惡夢：回合開始時，若對手（role）處於睡眠狀態，-50HP
    if (opPoke2 && opPoke2.ability?.id === 'nightmare-curse' && opPoke2.cur > 0 && !isAbilitySealedSrv(op, G) &&
        rolePoke2 && rolePoke2.cur > 0 && (rolePoke2.status?.type === 'sleep' || rolePoke2.status2?.type === 'sleep')) {
      rolePoke2.cur = Math.max(0, rolePoke2.cur - 50);
    }
    // 降雪（snowfall，2026-08-15新增）：每回合，只要持有者在場上，對手主戰-50HP
    for (const r2 of ['p1', 'p2']) {
      const poke2 = G[`${r2}Deck`]?.[G[`${r2}Idx`]];
      if (poke2?.ability?.id === 'snowfall' && poke2.cur > 0 && !isAbilitySealedSrv(r2, G)) {
        const opOfR2 = r2 === 'p1' ? 'p2' : 'p1';
        const opPoke3 = G[`${opOfR2}Deck`]?.[G[`${opOfR2}Idx`]];
        if (opPoke3 && opPoke3.cur > 0) opPoke3.cur = Math.max(0, opPoke3.cur - 50);
      }
    }
    // 恆淨之軀（purity-body，2026-08-15新增）：回合開始時（role即將行動）重複觸發清場地+封印對手特性
    if (rolePoke2?.ability?.id === 'purity-body' && rolePoke2.cur > 0 && !isAbilitySealedSrv(role, G)) {
      G.activeStadium = null;
      const sealKey2 = `${op}AbilitySealedTurns`;
      G[sealKey2] = Math.max(G[sealKey2] || 0, 1);
    }
    // 自然回復（natural-cure，2026-08-15新增）：回合開始時回復70HP
    if (rolePoke2?.ability?.id === 'natural-cure' && rolePoke2.cur > 0 && rolePoke2.cur < rolePoke2.hp && !isAbilitySealedSrv(role, G) && !isHealSealedSrv(role, G)) {
      rolePoke2.cur = Math.min(rolePoke2.hp, rolePoke2.cur + 70);
    }
    // 惡作劇之心（mischief-heart，2026-08-15新增）：回合結束時（op剛結束回合）重複觸發雙方手牌交換
    if (opPoke2?.ability?.id === 'mischief-heart' && opPoke2.cur > 0 && !isAbilitySealedSrv(op, G)) {
      [G.p1Hand, G.p2Hand] = [G.p2Hand, G.p1Hand];
      G.p1NeedsDiscard = G.p1Hand.length > 7;
      G.p2NeedsDiscard = G.p2Hand.length > 7;
    }
    // 潮漩（tide-vortex，2026-08-15新增）：回合結束時，50%機率讓對手（role）隨機棄掉一張手牌
    if (opPoke2?.ability?.id === 'tide-vortex' && opPoke2.cur > 0 && !isAbilitySealedSrv(op, G) && Math.random() < 0.5) {
      const roleHand3 = G[`${role}Hand`];
      if (roleHand3.length) roleHand3.splice(Math.floor(Math.random() * roleHand3.length), 1);
    }
  }
  // 全力出擊：上回合使用時「下回合無法回復能量」的代價，這裡直接跳過能量回復並清掉旗標
  // 壓迫感（pressure-drain，2026-08-14新增）：只要對方壓迫感持有者還在場上，這一側每回合的
  // 能量回復量就固定-3（下限0）——持續效果，不是onEnter一次性，跟pokemon_battle.html同步
  const opActiveForPressure = G[`${op}Deck`]?.[G[`${op}Idx`]];
  const rolePressureDrainCut = (!isAbilitySealedSrv(op, G) && opActiveForPressure?.ability?.id === 'pressure-drain') ? 3 : 0;
  if (G[`${role}EnergyBlockedNextTurn`]) {
    G[`${role}EnergyBlockedNextTurn`] = false;
  } else {
    G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + Math.max(0, 3 - rolePressureDrainCut));
  }
  // 時間咆哮（time-roar，2026-08-14修正：從「全部」改成「隨機一半」）：自己回合開始時，獲得
  // 對手上回合使用過的道具卡中隨機一半（無條件進位）——讀G[op+'ItemsPlayedThisTurn']（op上
  // 一次自己回合結束時累積的內容，這時候還沒被op自己的回合開始重置），跟pokemon_battle.html同步
  {
    const roleActive = G[`${role}Deck`][G[`${role}Idx`]];
    const opItemsPlayed = G[`${op}ItemsPlayedThisTurn`];
    if (roleActive.cur > 0 && !isAbilitySealedSrv(role, G) && roleActive.ability?.id === 'time-roar' && opItemsPlayed?.length) {
      const shuffled = [...opItemsPlayed].sort(() => Math.random() - 0.5);
      const stolen = shuffled.slice(0, Math.ceil(shuffled.length / 2));
      G[`${op}ItemsPlayedThisTurn`] = [];
      G[`${role}Hand`].push(...stolen);
      G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;
    }
  }
  // 堅韌（guts-cure-burst，2026-08-14新增）：自己回合開始時，若帶有異常狀態，解除並讓下次攻擊+20
  // （drawForRole沒有log參數——這裡跟同函式其餘場地效果一樣是靜默的state mutation，不推送log訊息）
  {
    const roleActive = G[`${role}Deck`][G[`${role}Idx`]];
    if (roleActive.cur > 0 && !isAbilitySealedSrv(role, G) && roleActive.ability?.id === 'guts-cure-burst' && (roleActive.status || roleActive.status2)) {
      roleActive.status = null; roleActive.status2 = null;
      G[`${role}Buff`].atkBonus = Math.max(G[`${role}Buff`].atkBonus, 20);
    }
  }
  // 反骨（retaliate-boost，2026-08-14從「受到攻擊後下次攻擊+10%」改成「上場與回合開始時+5能量」）：
  // 上場的部分在triggerOnEnterSrv處理，這裡是回合開始的部分，同樣靜默不推送log
  {
    const roleActive = G[`${role}Deck`][G[`${role}Idx`]];
    if (roleActive.cur > 0 && !isAbilitySealedSrv(role, G) && roleActive.ability?.id === 'retaliate-boost') {
      G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + 5);
    }
  }
  // 超幸運（super-luck-draw，2026-08-14新增）：上場與回合開始時，50%機率額外抽2張道具卡
  {
    const roleActive = G[`${role}Deck`][G[`${role}Idx`]];
    if (roleActive.cur > 0 && !isAbilitySealedSrv(role, G) && roleActive.ability?.id === 'super-luck-draw' && Math.random() < 0.5) {
      const hand = G[`${role}Hand`];
      hand.push(weightedPick(getDrawPool(roleActive.type, roleActive.type2)), weightedPick(getDrawPool(roleActive.type, roleActive.type2)));
      G[`${role}NeedsDiscard`] = hand.length > 7;
    }
  }
  // 不眠（insomnia，2026-08-14新增：每回合30%機率額外抽一張道具卡）
  {
    const roleActive = G[`${role}Deck`][G[`${role}Idx`]];
    if (roleActive.cur > 0 && !isAbilitySealedSrv(role, G) && roleActive.ability?.id === 'insomnia' && Math.random() < 0.3) {
      const hand = G[`${role}Hand`];
      hand.push(weightedPick(getDrawPool(roleActive.type, roleActive.type2)));
      G[`${role}NeedsDiscard`] = hand.length > 7;
    }
  }
  // 魔法鏡（magic-mirror，2026-08-14新增）：op自己回合結束時（＝role回合即將開始）25%機率架起反彈鏡
  {
    const opActiveForMirror = G[`${op}Deck`]?.[G[`${op}Idx`]];
    if (opActiveForMirror?.cur > 0 && !isAbilitySealedSrv(op, G) && opActiveForMirror.ability?.id === 'magic-mirror' && !G[`${op}Buff`].reflect && Math.random() < 0.25) {
      G[`${op}Buff`].reflect = true;
    }
  }
  // 集氣／消耗4-15的攻擊招式：上回合使用時承諾的「下回合額外能量」，這裡兌現後歸零（promote-then-consume）
  if (G[`${role}BonusEnergyNextTurn`]) {
    G[`${role}Energy`] = Math.min(20, G[`${role}Energy`] + G[`${role}BonusEnergyNextTurn`]);
    G[`${role}BonusEnergyNextTurn`] = 0;
  }
  // 灰燼決意：上回合使用時承諾的「下回合損失能量」，這裡兌現後歸零（promote-then-consume）
  if (G[`${role}EnergyLossNextTurn`]) {
    G[`${role}Energy`] = Math.max(0, (G[`${role}Energy`] || 0) - G[`${role}EnergyLossNextTurn`]);
    G[`${role}EnergyLossNextTurn`] = 0;
  }
  if (G.activeStadium?.id === 'stadium-mega-prism' && !G[`${role}MegaUsed`]) {
    G[`${role}MegaEnergy`] = Math.min(20, (G[`${role}MegaEnergy`] || 0) + 16);
  }
  // op已在函式開頭宣告過，這裡不用再宣告一次
  // 2026-08-13新增、2026-08-15改版：雙人對戰限定的逆風補償規則——回合開始時，若我方只剩1隻
  // 寶可夢、對方還有2隻以上、且該寶可夢HP低於50%，直接回滿血並多抽1張支援者卡。整場戰鬥每一方
  // 限觸發一次（G[role+'ComebackUsed']旗標標記），觸發後之後回合即使再符合條件也不會再發動。
  // 只在PvP做（single-player沒有這條規則，見使用者原文「雙人對戰額外規則」的明確限定範圍）。
  const roleAliveCount = G[`${role}Deck`].filter(p => p.cur > 0).length;
  const opAliveCount = G[`${op}Deck`].filter(p => p.cur > 0).length;
  if (roleAliveCount === 1 && opAliveCount >= 2 && !G[`${role}ComebackUsed`]) {
    const comebackPoke = G[`${role}Deck`][G[`${role}Idx`]];
    if (comebackPoke.cur > 0 && comebackPoke.cur < comebackPoke.hp * 0.5) {
      comebackPoke.cur = comebackPoke.hp;
      G[`${role}Hand`].push(pickSupporterAvoidingDupes(G[`${role}Hand`]));
      G[`${role}ComebackUsed`] = true;
      // 一次性旗標給broadcast()promote成獨立欄位讓client播救贖之光cutscene，見broadcast()裡的處理
      G.comebackTriggeredRole = role;
    }
  }
  // 亡靈詛咒／暗影封鎖／封印特性／詛咒／妖精結界：2026-07-30應使用者回報「最後一回合效果應該
  // 還在，結果圖示還在效果卻沒了」修正——這幾個「N回合」倒數原本放在role自己回合開始時扣，
  // 會在role自己的最後一個有效回合就先扣成0，導致該回合的判定（isAbilitySealedSrv等）提前
  // 一整回合失效。改成在op（也就是被封印/被免疫那一方）自己回合剛結束、role回合開始時才扣，
  // 讓被封印方自己回合內、以及緊接著對方回合內的判定都還讀得到扣減前的值，正好蓋滿宣告的回合數。
  if (G[`${op}MegaSealedTurns`] > 0) G[`${op}MegaSealedTurns`]--;
  if (G[`${op}AbilitySealedTurns`] > 0) G[`${op}AbilitySealedTurns`]--;
  if (G[`${op}HealSealedTurns`] > 0) G[`${op}HealSealedTurns`]--;
  if (G[`${op}StatusImmuneTurns`] > 0) G[`${op}StatusImmuneTurns`]--;
  // 寄生種子：接下來N回合，每回合開始從對方身上吸取能量
  if (G[`${role}LeechTurns`] > 0) {
    const amt = Math.min(3, G[`${op}Energy`] || 0);
    G[`${op}Energy`] = (G[`${op}Energy`] || 0) - amt;
    G[`${role}Energy`] = Math.min(20, (G[`${role}Energy`] || 0) + amt);
    G[`${role}LeechTurns`]--;
  }
  const activePoke = G[`${role}Deck`][G[`${role}Idx`]];
  // 強子引擎／緋紅脈動／漩渦威壓／惡作劇之心：每回合開始的額外抽卡特性
  rollTurnStartAbilityDrawSrv(activePoke, role, G);
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
    G[`${role}Hand`].push(pickSupporterAvoidingDupes(G[`${role}Hand`]));
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

/* ═══════════════════════════════════════════
   POCKET TCG（雙人PvP，真實PTCG Pocket規則）
   完全獨立的房間系統，不跟上面既有的 rooms/G 戰鬥狀態共用——
   兩套規則(能量池 vs 能量區、無進化 vs 進化、無牌組 vs 20張牌組)差異太大，
   混在一起只會讓既有PvP的debug變複雜。詳見 /Users/mike/.claude/plans/parsed-dancing-comet.md
═══════════════════════════════════════════ */
const pocketRooms = new Map();
// 2026-08-06大改版：從106張A1精選卡擴充成A1~B2a全15個系列、共2480張官方卡片（TCGdex目前
// 資料涵蓋到B2a為止，B2b/B3/B3a/B3b/B4這5個更新的系列TCGdex還沒有資料，之後TCGdex補上
// 再重跑同一套匯入腳本即可——腳本在scratchpad，不進repo，比照原本curation慣例）。
// 資料結構也跟著簡化：不再用「base卡+nested variants」表示同一張卡的不同星等重印版，
// 改成每張卡都是獨立的扁平頂層entry（包含原本歸在variants裡的高星重印版），2星以上
// 直接靠rarity欄位本身判斷要不要進追逐卡池，不用再猜「哪張是base、哪張是variant」。
const pocketCardsFile = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'pocket-cards.json'), 'utf8'));
const POCKET_CARDS = pocketCardsFile.cards;
// 2026-08-16應使用者回報修正：TCGdex來源資料裡，真實卡面完全沒印能量符號的「免費招式」
// （例如盆才怪「淚眼攻擊」），部分卡片被錯誤標成cost:['0']（字面上的字串'0'，不是真的能量
// 屬性）——pocketCanPayCost會把'0'當成一種永遠不存在、永遠付不出來的能量屬性去比對，導致
// 這類招式實際上永遠打不出來。在資料載入的當下就把'0'從所有cost陣列裡濾掉，變回真正0能量
// 需求的免費招式，這樣下游（付費檢查、client端能量圖示顯示）都不用個別特判'0'這個字面值。
for (const c of POCKET_CARDS) {
  for (const a of (c.attacks || [])) {
    if (a.cost) a.cost = a.cost.filter(t => t !== '0');
  }
}
// 2026-08-17使用者自訂調整：直接覆寫既有卡片的HP/特性/招式/撤退（寶可夢）或效果文字（訓練師卡），
// 依英文name比對——同一隻寶可夢/同一張訓練師卡在遊戲裡每個罕貴度重印版本的name都相同，一次改動
// 全部套用，不用逐一列每個id。每個override額外算出一個_patch欄位（記錄「哪個欄位、舊值、新值」），
// 給client端在卡片放大顯示時判斷要疊哪個修改圖層、疊什麼文字。
const POCKET_CARD_OVERRIDES = {
  'Nidorina': {
    addAbility: {
      type: 'Ability', name: 'Attraction', name_zh: '吸引',
      effect: 'Once during your turn, you may put up to 2 Nidorino from your deck onto your Bench.',
      effect_zh: '在你的回合中，你可以從你的牌組中放上限2張尼多力諾到你的板凳上。',
    },
  },
  'Nidorino': {
    addAbility: {
      type: 'Ability', name: 'Fighting Spirit', name_zh: '鬥爭心',
      effect: 'At the end of your turn, draw a Nidoking from your deck.',
      effect_zh: '在你的回合結束時，從你的牌組抽一張尼多王加入手牌。',
    },
  },
  'Brock': {
    effect: 'Take 1 {F} Energy from your Energy Zone and attach it to 1 of your Fighting Pokémon.',
    effect_zh: '從能量區拿1個格鬥能量，貼在你的1隻格鬥屬性寶可夢身上。',
  },
  'Blue': {
    effect: "During your opponent's next turn, all of your Pokémon take −80 damage from attacks from your opponent's Pokémon.",
    effect_zh: '在對手的下個回合，你所有的寶可夢受到對手寶可夢招式的傷害-80。',
  },
  'Misty': {
    effect: 'Choose 1 of your Pokémon, and flip a coin until you get tails. For each heads, take a {W} Energy from your Energy Zone and attach it to that Pokémon.',
    effect_zh: '選擇你的1隻寶可夢，擲硬幣直到出現反面為止。每次出現正面，就從能量區取出1個{W}能量附加到該寶可夢身上。',
  },
};
for (const c of POCKET_CARDS) {
  const ov = POCKET_CARD_OVERRIDES[c.name];
  if (!ov) continue;
  const patch = {};
  if (ov.hp != null && c.hp !== ov.hp) { patch.hp = { old: c.hp, new: ov.hp }; c.hp = ov.hp; }
  if (ov.retreat != null && c.retreat !== ov.retreat) { patch.retreat = { old: c.retreat, new: ov.retreat }; c.retreat = ov.retreat; }
  if (ov.addAbility && !c.abilities?.length) { patch.addedAbility = true; c.abilities = [ov.addAbility]; }
  if (ov.effect != null && c.effect !== ov.effect) {
    patch.effect = { old: c.effect_zh || c.effect, new: ov.effect_zh || ov.effect };
    c.effect = ov.effect;
    c.effect_zh = ov.effect_zh || ov.effect;
  }
  if (Object.keys(patch).length) c._patch = patch;
}
const POCKET_SETS = pocketCardsFile.sets; // [{id, name, cardCount}]，開包/圖鑑選版本用
// 星等以上（含新系列引入的Shiny）都算「追逐卡池」——高星Trainer卡（角色支援者重印版）
// 由匯入腳本預先算好effectId指回同系列內最早印刷的那張卡id，TRAINER_EFFECTS才查得到效果
// （效果查找機制本身沒變，只是分組計算搬到匯入腳本做，不再是server.js runtime現算）。
const POCKET_HIGH_RARITIES = new Set(['One Star', 'Two Star', 'Three Star', 'Crown', 'One Shiny', 'Two Shiny']);
const POCKET_CARDS_BASE = POCKET_CARDS.filter(c => !POCKET_HIGH_RARITIES.has(c.rarity));
const POCKET_CHASE_CARDS = POCKET_CARDS.filter(c => POCKET_HIGH_RARITIES.has(c.rarity));
const POCKET_CARDS_BY_ID = Object.fromEntries(POCKET_CARDS.map(c => [c.id, c]));

// server端權威驗證，不信任client算好的合法性（比照現有PvP「不信任client」的慣例）
function validatePocketDeck(deckIds) {
  if (!Array.isArray(deckIds) || deckIds.length !== 20) return '牌組需要剛好 20 張';
  const counts = {};
  for (const id of deckIds) {
    const card = POCKET_CARDS_BY_ID[id];
    if (!card) return '牌組包含不存在的卡片';
    counts[id] = (counts[id] || 0) + 1;
    if (counts[id] > 2) return `${card.name} 最多只能放 2 張`;
  }
  const hasBasic = deckIds.some(id => {
    const c = POCKET_CARDS_BY_ID[id];
    return c.category === 'Pokemon' && c.stage === 'Basic';
  });
  if (!hasBasic) return '牌組至少需要 1 張基礎寶可夢';
  return null;
}

/* ── Pocket TCG：核心回合引擎 ──
   規則依據官方FAQ確認過的細節（不是憑印象猜的）：
   - 先攻方第1回合沒有能量區能量，但雙方從第1回合起都會抽牌
   - 能量區從第2回合（即後攻方第1回合）開始每回合產生1點
   - 板凳上限3隻；撤退/回合限1次；支援者1張/回合（Phase 5才做，這裡還沒有支援者牌可打）
   - 擊倒一般寶可夢1分/ex寶可夢2分，先到3分獲勝；牌庫在該抽牌時是空的直接落敗
   - 這個階段刻意只算招式的固定傷害數字+弱點，招式文字效果(擲硬幣加成/狀態異常/治療等)
     跟訓練師卡一樣先不做，之後合併到同一批「卡片效果」裡處理 */
let pocketUidCounter = 1;
function makePocketInstance(cardId) {
  const base = POCKET_CARDS_BY_ID[cardId];
  return {
    ...structuredClone(base),
    uid: `c${pocketUidCounter++}`,
    curHp: base.hp ?? null,
    energy: [],
    boardTurn: null, // 進場/最近一次進化的回合數，用來擋「這回合不能進化」
    status: null, // null | 'asleep' | 'paralyzed' | 'confused' —— 這三種互斥，同時間只會有其中一種
    // 2026-08-13新增：中毒／灼傷改成獨立布林欄位，可以跟上面的status同時存在（也可以彼此同時
    // 存在），符合真實TCG規則——中毒/灼傷不屬於「三選一」那組，只有睡眠/麻痺/混亂互斥
    poisoned: false,
    burned: false,
    cantAttackUntilTurn: 0, // === G.turnNumber 時這回合不能攻擊（用turnNumber比對，過了自然失效不用額外清）
    cantRetreatUntilTurn: 0,
    dmgDebuffUntilTurn: 0,
    dmgDebuffAmount: 0,
    isFossil: false,
    tool: null, // 2026-08-07新增Pokémon Tool系統：附加的道具卡物件(null=沒有裝備)，每隻寶可夢最多1張
  };
}
// 化石道具卡（Helix/Dome/Old Amber等）：文字是「當作40HP無色基礎寶可夢上場」，
// 上場時把Trainer卡臨時轉成一張虛擬的寶可夢卡放進board，不進TRAINER_EFFECTS的一般道具流程。
// 2026-08-06擴充：原本只列了A1的3張，其實A1a/A2/B1/B2都各自有新的化石卡（Skull/Armor/
// Plume/Cover/Jaw/Sail Fossil）跟Old Amber的重印(A1a-063)，效果文字逐字相同，
// makePocketFossilInstance本來就是從卡片原始資料讀name/image動態生成，不用額外改邏輯，
// 只要把id補進這個Set就全部能用了。
const POCKET_FOSSIL_IDS = new Set(['A1-216', 'A1-217', 'A1-218', 'A1a-063', 'A2-144', 'A2-145', 'B1-214', 'B1-216', 'B2-144', 'B2-146', 'B4-146', 'B4-147']);
// 2026-08-08新增：「Ancient Pokémon」/「Future Pokémon」是這批卡才出現的新archetype標籤，
// CSV資料沒有掃到任何rules-box欄位能判斷「哪些寶可夢算」——固定寫死成真實對戰卡池已知的
// 準古神獸清單（Iron開頭=Future，其餘=Ancient，這是SV系列公開的官方分類，不是猜的）
// Koraidon/Miraidon（含ex）本身也印有Ancient/Future規則框標記，不是只有典型的準古/近未來
// Paradox寶可夢才算——2026-08-09補上，之前漏掉導致Professor Turo選密勒頓ex時判斷失敗
const ANCIENT_POKEMON_NAMES = new Set(['Great Tusk', 'Scream Tail', 'Brute Bonnet', 'Flutter Mane', 'Slither Wing', 'Sandy Shocks', 'Roaring Moon', 'Walking Wake', 'Gouging Fire', 'Raging Bolt', 'Koraidon', 'Koraidon ex']);
const FUTURE_POKEMON_NAMES = new Set(['Iron Treads', 'Iron Bundle', 'Iron Hands', 'Iron Jugulis', 'Iron Moth', 'Iron Thorns', 'Iron Valiant', 'Iron Leaves', 'Iron Boulder', 'Iron Crown', 'Miraidon', 'Miraidon ex']);
// 2026-08-13新增：4張Tool卡帶「條件式固定+HP」——原本只在裝備當下手動target.hp+=N一次性套用
// （見pocket-tcg專案記憶的Tool系統設計說明，這個設計本身沒問題），但進化時target.hp會被
// Object.assign(structuredClone(POCKET_CARDS_BY_ID[...]))整個換成新物種的印刷HP，蓋掉這個
// 一次性加成，卻沒有依進化後的新條件重新判斷要不要補回來——玩家回報「裝了Leaf Cape的三蜜蜂，
// 進化成蜂女王後+30血量不見了」（蜂女王同樣是草屬性，理應繼續有加成，卻整個消失了）。
// 抽成表格＋共用函式，pocket_evolve handler呼叫這個算出「進化前/後各自的加成」再做差值調整，
// 4個裝備handler本身也一併改用同一份判斷邏輯，避免條件寫兩次以後兩邊各自維護不同步。
const TOOL_HP_BONUS = {
  'A2-147': { amount: 20, condition: () => true }, // Giant Cape：無條件
  'A3-147': { amount: 30, condition: (p) => (p.types || []).includes('Grass') }, // Leaf Cape
  'B3a-069': { amount: 40, condition: (p) => ANCIENT_POKEMON_NAMES.has(p.name) }, // Ancient Booster Energy Capsule
  'B3b-065': { amount: 30, condition: (p) => p.stage === 'Stage1' }, // Elegant Cape
};
function pocketToolHpBonusAmount(poke) {
  const cfg = poke.tool && TOOL_HP_BONUS[poke.tool.id];
  return (cfg && cfg.condition(poke)) ? cfg.amount : 0;
}
// 棄置一隻寶可夢身上裝備的Tool，正確收回HP加成——修正原本3處各自手刻的棄置邏輯：只認
// A2-147/A3-147兩張（B3a-069/B3b-065漏掉，移除完全沒收回加成）、且用Math.min(curHp,hp)
// 「夾住」而不是真的扣除，等於只讓curHp不超過新的hp上限，血量剛好卡在加成邊緣的寶可夢
// 移除加成後應該倒下卻沒有倒下（使用者回報「道具被棄置時，血量歸零應該倒下卻沒倒下」）。
// 這裡只負責調整數字，不負責判定KO——curHp<=0之後的倒下/棄置/加分/forced_switch，攻擊路徑
// （"Before doing damage..."）交給pocket_attack handler本來就有的攻擊後curHp<=0檢查；
// 非攻擊的Trainer卡路徑（A3-151/B3-147）則交給pocketBroadcastState裡的pocketResolveAmbientKOs
// 統一收尾（endsTurn=false，不是攻擊/中毒造成的KO，不該連帶結束回合）。
function pocketDiscardTool(p) {
  if (!p.tool) return 0;
  const bonus = pocketToolHpBonusAmount(p);
  if (bonus > 0) {
    p.hp = Math.max(10, p.hp - bonus);
    p.curHp = Math.max(0, p.curHp - bonus);
  }
  p.tool = null;
  return bonus;
}
function makePocketFossilInstance(cardId) {
  const base = POCKET_CARDS_BY_ID[cardId];
  return {
    id: base.id, name: base.name, category: 'Pokemon', image: base.image, ex: false,
    types: ['Colorless'], hp: 40, stage: 'Basic', evolveFrom: null, attacks: [], abilities: null,
    weaknesses: null, retreat: null, // retreat:null → 之後檢查撤退時視為「不能撤退」
    uid: `c${pocketUidCounter++}`, curHp: 40, energy: [], boardTurn: null,
    status: null, cantAttackUntilTurn: 0, cantRetreatUntilTurn: 0, dmgDebuffUntilTurn: 0, dmgDebuffAmount: 0,
    isFossil: true, tool: null,
  };
}
function pocketIsPlayableAsBasic(handCard) {
  return (handCard.category === 'Pokemon' && handCard.stage === 'Basic') || POCKET_FOSSIL_IDS.has(handCard.id);
}
// 效果文字裡的{X}符號對應的真實屬性名稱，只有Double Type需要從文字反推屬性（其他地方
// {X}純粹是給玩家看的顯示文字，不會被程式解析）
const ENERGY_LETTER_TO_TYPE = { R: 'Fire', W: 'Water', L: 'Lightning', G: 'Grass', P: 'Psychic', F: 'Fighting', D: 'Darkness', M: 'Metal', C: 'Colorless', N: 'Dragon' };
// Double Type（2026-08-08新增）：「As long as this Pokémon is in play, it is {X} and {Y}
// type」——從特性原文直接反推要附加的屬性字母，不用為每張卡各自寫死屬性名稱。跟_realAbilities
// 快取同一個道理：這隻寶可夢的身分（types）可能在好幾個地方被mutate（上場/進化/退化/借身），
// 每一個Object.assign(...structuredClone(POCKET_CARDS_BY_ID))的identity mutation點都要呼叫
// 這個函式重算一次，不能只在「初次上場」做——不然進化成Double Type持有者不會補上第二屬性。
function pocketApplyDoubleType(poke) {
  if (poke?.abilities?.[0]?.name !== 'Double Type') return;
  const letters = [...(poke.abilities[0].effect || '').matchAll(/\{([A-Za-z])\}/g)].map(m => m[1]);
  const extraTypes = letters.map(l => ENERGY_LETTER_TO_TYPE[l]).filter(Boolean);
  if (extraTypes.length) poke.types = [...new Set([...(poke.types || []), ...extraTypes])];
}
function pocketInstantiateBoardCard(handCard, turnNumber) {
  const inst = POCKET_FOSSIL_IDS.has(handCard.id) ? makePocketFossilInstance(handCard.id) : handCard;
  inst.boardTurn = turnNumber;
  pocketApplyDoubleType(inst);
  return inst;
}
function pocketShuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pocketDeckEnergyTypes(deckIds) {
  const set = new Set();
  for (const id of deckIds) {
    const c = POCKET_CARDS_BY_ID[id];
    if (c.category === 'Pokemon') for (const t of (c.types || [])) if (t !== 'Colorless') set.add(t);
  }
  return set.size ? [...set] : ['Colorless'];
}
// 2026-08-06新增：玩家可以手動自選能量區出現的屬性，取代原本純自動偵測。
// POCKET_ENERGY_TYPE_LIST是合法可選的清單（Colorless不在其中——那不是能量區真的會生成的屬性，
// 跟pocketDeckEnergyTypes原本排除Colorless的邏輯一致）。
const POCKET_ENERGY_TYPE_LIST = ['Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Dragon', 'Grass', 'Metal'];
function pocketValidateEnergyTypes(types) {
  if (!Array.isArray(types) || !types.length) return null;
  const filtered = [...new Set(types.filter(t => POCKET_ENERGY_TYPE_LIST.includes(t)))];
  return filtered.length ? filtered : null;
}
function pocketDrawOpeningHand(deckIds) {
  let instances = pocketShuffle(deckIds.map(makePocketInstance));
  let hand = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    hand = instances.slice(0, 5);
    if (hand.some(c => c.category === 'Pokemon' && c.stage === 'Basic')) break;
    instances = pocketShuffle(instances);
  }
  return { hand, deck: instances.slice(5) };
}
function buildPocketG(pRoom) {
  const p1 = pocketDrawOpeningHand(pRoom.p1Deck);
  const p2 = pocketDrawOpeningHand(pRoom.p2Deck);
  return {
    turn: pRoom.firstPlayer, turnNumber: 1, phase: 'setup', winner: null, pendingSwitchRole: null, pendingSwitchReason: null,
    pendingChoice: null,
    eventSeq: 0, lastEvent: null,
    // 卡牌發動顯示（2026-08-08新增）：跟lastEvent（單一最新事件，給擲硬幣/傷害飄字用）不同，
    // 這裡故意用「一直append的陣列」而不是單一欄位——同一次處理裡可能連續觸發好幾張卡
    // （例如攻擊→on-hit特性→KO→KO觸發特性），單一欄位會被後面的直接覆蓋掉，client永遠看
    // 不到中間那些。client端用seq判斷「哪些是還沒播放過的」，依序播放，不是只看最後一個。
    cardEventSeq: 0, cardActivations: [],
    p1: pocketFreshSide(p1, pRoom.p1Deck, pRoom.p1EnergyTypes),
    p2: pocketFreshSide(p2, pRoom.p2Deck, pRoom.p2EnergyTypes),
  };
}
// label是給玩家看的中文簡短說明（例如「使用特性」「使用道具卡」「特性觸發」），card可以是
// Pokemon實例(讀.name/.image)或Trainer卡物件(同樣讀.name/.image，欄位剛好一致)。陣列裁到
// 最近20筆，避免長對局累積過大（client只在意seq還沒播放過的那幾筆，不需要完整歷史）。
function pocketEmitCardActivation(G, role, card, label) {
  if (!card) return;
  G.cardActivations = G.cardActivations || [];
  G.cardActivations.push({ seq: ++G.cardEventSeq, role, name: card.name, image: card.image, label });
  if (G.cardActivations.length > 20) G.cardActivations.shift();
}
// Tool物件在寶可夢instance上只存{id,name}（沒有image，見makePocketInstance/attach handler），
// 跟pocketEmitCardActivation預期的「有.image欄位的卡物件」形狀不同，這裡額外查一次
// POCKET_CARDS_BY_ID補上圖片，避免顯示出來的彈窗沒有卡圖
function pocketEmitToolActivation(G, role, tool, label) {
  if (!tool) return;
  const full = POCKET_CARDS_BY_ID[tool.id];
  pocketEmitCardActivation(G, role, full || tool, label);
}
function pocketFreshSide(drawn, deckIds, energyTypesOverride) {
  return {
    ...drawn, active: null, bench: [], discard: [], points: 0, pendingEnergy: null, previewEnergy: null,
    // 2026-08-08新增：真實規則裡任何被棄置的能量（不管來源是招式成本、攻擊者自傷、或場地卡
    // 效果）都會進到一個共用、可被「從棄牌堆拿能量」類效果撿回的能量棄牌區——這個引擎原本
    // 完全沒有這個概念，只把「殘留在被擊倒寶可夢卡身上的能量」當作棄牌堆能量來源。Rainbow
    // Cave（能量區棄置重抽）第一個踩到這個缺口：棄掉的能量憑空消失，Dragon's Blessing之後
    // 找不到。discardEnergy只承接「沒有卡片可以掛」的這類能量，見pocketTakeEnergyFromDiscard
    discardEnergy: [],
    energyAttachedThisTurn: false, retreatedThisTurn: false, supporterUsedThisTurn: false,
    energyTypes: energyTypesOverride || pocketDeckEnergyTypes(deckIds), boardReady: false,
    giovanniBoostThisTurn: false, blaineBoostNamesThisTurn: null, retreatDiscountThisTurn: 0,
    abilitiesUsedThisTurn: [], supporterLockedUntilTurn: 0,
    // 2026-08-06新增：通用版「指名寶可夢/指名屬性本回合加傷」——跟blaineBoostNamesThisTurn
    // 是同一種概念，但把加傷數值也一起存進物件裡，不像giovanni/blaine那樣寫死+10/+30，
    // 讓之後新卡（例如Clemont's Backpack指名Magneton/Heliolisk +20、熱情之聲對火屬性+50）
    // 可以直接重用，不用每張卡都各自加一個新欄位+一段mainDamage判斷式。
    namedBoostThisTurn: null, typeBoostThisTurn: null,
    itemLockedUntilTurn: 0, energyLockedUntilTurn: 0,
    // 2026-08-07新增：Red「己方全體攻擊對ex目標+20」——namedBoostThisTurn是「限定寶可夢」，
    // 這個是「不限定寶可夢，但限定目標是ex」，維度不同所以另開一個欄位而不是硬塞進既有的
    exOnlyBoostThisTurn: 0,
  };
}
function pocketPickEnergy(types) {
  return types[Math.floor(Math.random() * types.length)];
}
// 能量區「產生下一個能量」的共用邏輯——不管是回合開始自然觸發，還是Rainbow Cave這種回合中
// 提前觸發，規則都一樣：pendingEnergy直接繼承previewEnergy（那份「下一個能量」本來就已經
// 產生好、玩家已經看過預覽，不是重新roll一個新的），previewEnergy再重新roll一份新的預覽。
function pocketProduceEnergy(side) {
  if (side.nextEnergyOverride) {
    side.pendingEnergy = side.nextEnergyOverride;
    side.nextEnergyOverride = null;
  } else {
    side.pendingEnergy = side.previewEnergy || pocketPickEnergy(side.energyTypes);
  }
  side.previewEnergy = pocketPickEnergy(side.energyTypes);
}
// 第1回合（先攻方）沒有能量區能量，但雙方從第1回合就要抽牌
// 2026-08-08修正：使用者確認Pocket TCG（跟紙牌版TCG不同）沒有「牌庫抽完直接落敗」這條規則
// ——原本這裡誤套用了紙牌版TCG的通用慣例，已移除；牌庫空的時候單純不抽牌，不判定勝負
function pocketStartFirstTurn(G) {
  const side = G[G.turn];
  if (side.deck.length > 0) side.hand.push(side.deck.shift());
  // 2026-08-08新增：能量預覽——雙方一開局就先各自算好「自己第一次會拿到的能量」，不用等
  // pocketStartNextTurn第一次幫該側跑過一輪才有預覽可看（先攻方要到第3回合才會有能量，
  // 但從對局一開始就該讓他看到「你的第一份能量會是X」，不是憑空卡在null直到第3回合前一刻）
  G.p1.previewEnergy = pocketPickEnergy(G.p1.energyTypes);
  G.p2.previewEnergy = pocketPickEnergy(G.p2.energyTypes);
}
// 中毒在「該側回合結束」時扣血（不是對手回合結束）——真實TCG通用時機慣例
// Pokémon Checkup（回合結束當下的狀態結算）：中毒/燒傷/麻痺 + 回合結束觸發型被動特性。
// 只會、也應該對每個「真正結束的回合」執行恰好一次——回傳true代表被KO換人打斷（呼叫端
// 必須停在這裡，等對方選完替補寶可夢後直接呼叫pocketStartNextTurn，不能重新呼叫這個
// 函式，否則endingSide/被Snowy Terrain打中的那方會被重複結算一次checkup，見下方
// pocketAdvanceTurn跟pocket_choose_active handler的說明）。
function pocketRunCheckup(G) {
  const endingRole = G.turn;
  const endingSide = G[endingRole];
  const otherRoleForCheckup = endingRole === 'p1' ? 'p2' : 'p1';
  const otherSideForCheckup = G[otherRoleForCheckup];
  // Flower Shield/Soothing Wind：每次checkup當一層防呆保底（見pocketApplySoothingCure定義處
  // 的說明），跑在中毒/灼傷扣血之前，這樣萬一漏抓某個「新符合資格」的時機點，至少不會多扣這次的傷害
  pocketApplySoothingCure(endingSide);
  pocketApplySoothingCure(otherSideForCheckup);
  // 2026-08-13修正：中毒/灼傷改成獨立布林欄位（可以彼此同時存在，也可以跟status欄位的睡眠/
  // 麻痺/混亂同時存在），這裡改成各自獨立的if（不是互斥的.status===比對），兩個都成立時兩段
  // 傷害都會結算——真實TCG規則本來就允許同時中毒+灼傷各自扣血
  if (endingSide.active && endingSide.active.poisoned) {
    // More Poison：對手（otherSideForCheckup，中毒debuff的施加方）主戰持有時，中毒傷害10→20
    const poisonBonus = otherSideForCheckup.active?.abilities?.[0]?.name === 'More Poison' ? 10 : 0;
    // Toxicroak（2026-08-08新增）：卡面明講「instead of the usual amount」——這次中毒的傷害
    // 直接被覆蓋成固定值，不跟More Poison的+10疊加（"instead of"字面意思就是取代，不是疊加）
    const poisonAmount = endingSide.active.poisonDamageOverride != null ? endingSide.active.poisonDamageOverride : 10 + poisonBonus;
    endingSide.active.curHp = Math.max(0, endingSide.active.curHp - poisonAmount);
    if (endingSide.active.curHp <= 0) {
      pocketResolveActiveKO(G, endingRole);
      if (G.phase === 'forced_switch' || G.phase === 'done') return true;
    }
  }
  // 2026-08-06新增：灼傷（Burned）——跟中毒同樣在該側回合結束時扣血，但傷害是20（中毒10）
  // 且扣完血額外擲一次硬幣，正面直接治癒灼傷（這點中毒沒有，中毒要等到被其他效果解除才會消失，
  // 灼傷則是真實規則裡本來就會「自己有機會好」的限時debuff，跟中毒設計成兩種不同持續時間的異常）。
  if (endingSide.active && endingSide.active.burned) {
    endingSide.active.curHp = Math.max(0, endingSide.active.curHp - 20);
    if (endingSide.active.curHp <= 0) {
      pocketResolveActiveKO(G, endingRole);
      if (G.phase === 'forced_switch' || G.phase === 'done') return true;
    } else {
      // 2026-08-11修正：這顆治癒硬幣原本完全沒有回饋，玩家看不到到底有沒有真的擲——
      // 補上lastEvent，跟Mesagoza同一個修法。checkup只會執行一次（每次回合切換endingSide
      // 只有一側），不會有兩顆硬幣搶著設同一個G.lastEvent的疑慮
      const cured = pocketFlipCoin({ G, role: endingRole });
      G.lastEvent = { seq: ++G.eventSeq, kind: 'checkup', coinFlips: [cured] };
      if (cured) endingSide.active.burned = false;
    }
  }
  // 麻痺（跟睡眠/中毒不同）在真實規則裡是限時debuff：只擋這一整個回合的攻擊/撤退，
  // 回合結束就解除——不是像原本那樣只有「嘗試攻擊失敗」才會清掉。原本的寫法會讓玩家
  // 選擇不攻擊（例如先蓄能量）時麻痺永遠不會解除，撤退又同時被麻痺擋死，等於卡死。
  // 這裡在麻痺方回合真正結束時清除，攻擊handler自己觸發的失敗清除（見pocket_attack
  // 的paralyzed分支）跟這裡不會衝突——那條路徑執行到這裡時status早就已經是null了。
  if (endingSide.active?.status === 'paralyzed') endingSide.active.status = null;
  // 回合結束觸發型被動特性（"At the end of your turn, if this Pokémon is in the Active
  // Spot..."）：Full-Mouth Manner回血、Legendary Pulse抽牌、Snowy Terrain對對方主戰造成10傷害。
  // 掛在endingSide真正結束回合的這個時間點，跟中毒/燒傷扣血是同一個Pokémon Checkup時機。
  const endingAbility = endingSide.active?.abilities?.[0]?.name;
  if (endingAbility === 'Full-Mouth Manner' && endingSide.active.curHp > 0) {
    endingSide.active.curHp = Math.min(endingSide.active.hp, endingSide.active.curHp + 20);
    pocketEmitCardActivation(G, endingRole, endingSide.active, '特性觸發：Full-Mouth Manner');
  }
  if (endingAbility === 'Legendary Pulse' && endingSide.active.curHp > 0 && endingSide.deck.length > 0) {
    endingSide.hand.push(endingSide.deck.shift());
    pocketEmitCardActivation(G, endingRole, endingSide.active, '特性觸發：Legendary Pulse');
  }
  // 尼多力諾（使用者自訂特性，2026-08-17新增，同日應使用者要求修正：不限主戰位置也能觸發）：
  // 回合結束時，場上每一隻鬥爭心持有者（不限主戰/板凳）各自從牌組搜1張「尼多王」加入手牌——
  // 是指定搜尋不是隨機抽牌，所以跟Legendary Pulse（單純抽牌庫頂）不同，搜完要洗牌；只認完全
  // 等於'Nidoking'的name，剛好天然排除掉'Nidoking ex'（不同字串）。跟Bad Dreams同一種「場上
  // 有幾隻持有者就各自觸發幾次」寫法，牌組裡的尼多王被前一隻搜光了，後面持有者直接break。
  const fightingSpiritHolders = [endingSide.active, ...endingSide.bench].filter(p => p?.curHp > 0 && p?.abilities?.[0]?.name === 'Fighting Spirit');
  for (const holder of fightingSpiritHolders) {
    const idx = endingSide.deck.findIndex(c => c.category === 'Pokemon' && c.name === 'Nidoking');
    if (idx < 0) break;
    const [card] = endingSide.deck.splice(idx, 1);
    endingSide.hand.push(card);
    endingSide.deck = pocketShuffle(endingSide.deck);
    pocketEmitCardActivation(G, endingRole, holder, '特性觸發：Fighting Spirit');
  }
  if (endingAbility === 'Snowy Terrain' && endingSide.active.curHp > 0 && otherSideForCheckup.active) {
    otherSideForCheckup.active.curHp = Math.max(0, otherSideForCheckup.active.curHp - 10);
    pocketEmitCardActivation(G, endingRole, endingSide.active, '特性觸發：Snowy Terrain');
    if (otherSideForCheckup.active.curHp <= 0) {
      pocketResolveActiveKO(G, otherRoleForCheckup);
      if (G.phase === 'forced_switch' || G.phase === 'done') return true;
    }
  }
  // Thunderclap Flash（2026-08-08新增）：「At the end of your first turn」——checkup執行的當下
  // G.turnNumber還沒遞增，turnNumber<=2恆等於「endingSide正在結束的這個回合是它自己的第一回合」
  // （turn 1=先攻方第一回合、turn 2=後攻方第一回合，不管誰先攻都成立，不需要額外查firstPlayer）。
  // 不限持有者在主戰/板凳，跟Snowy Terrain(限定主戰)不同，掃全場
  if (G.turnNumber <= 2) {
    // 2026-08-08修正：原本用find()只抓場上第一隻符合的持有者，場上同時有2隻以上Zeraora時
    // 只有一隻會觸發——這個特性沒有「每回合限用1次」的場地限定，應該每一隻持有者都各自觸發
    const holders = [endingSide.active, ...endingSide.bench].filter(p => p?.abilities?.[0]?.name === 'Thunderclap Flash');
    for (const holder of holders) { holder.energy.push('Lightning'); pocketEmitCardActivation(G, endingRole, holder, '特性觸發：Thunderclap Flash'); }
  }
  // 回合結束觸發型Tool（2026-08-07新增）：Leftovers只在主戰位置生效，Lum Berry/Sitrus Berry
  // 沒有位置限制（"the Pokémon this card is attached to"沒有寫"in the Active Spot"），要檢查
  // endingSide全部在場寶可夢（主戰+板凳），不只active一隻
  if (endingSide.active?.tool?.id === 'A3b-067' && endingSide.active.curHp > 0) { // Leftovers
    endingSide.active.curHp = Math.min(endingSide.active.hp, endingSide.active.curHp + 10);
  }
  [endingSide.active, ...endingSide.bench].filter(Boolean).forEach(p => {
    if (p.tool?.id === 'A2-149' && (p.status != null || p.poisoned || p.burned)) { // Lum Berry：解除異常狀態後棄置自己
      p.status = null;
      p.poisoned = false;
      p.burned = false;
      p.tool = null;
    }
    if (p.tool?.id === 'B1-218' && p.curHp > 0 && p.curHp <= p.hp / 2) { // Sitrus Berry：HP過半才觸發，回復後棄置自己
      p.curHp = Math.min(p.hp, p.curHp + 30);
      p.tool = null;
    }
  });
  // Bad Dreams（2026-08-08新增）：「At the end of EACH turn」——不像Full-Mouth Manner等只在
  // 持有者自己回合結束時觸發，這個雙方向都要檢查：endingSide持有時打otherSideForCheckup的
  // 睡眠主戰，otherSideForCheckup持有時打endingSide的睡眠主戰（因為對otherSideForCheckup
  // 來說，endingSide的回合剛結束正好也是「每一個回合結束」的其中一次）
  for (const [holderSide, targetSide, targetRole] of [[endingSide, otherSideForCheckup, otherRoleForCheckup], [otherSideForCheckup, endingSide, endingRole]]) {
    // 2026-08-16修正：跟Thunderclap Flash同一種bug——原本用find()只抓場上第一隻持有者，
    // 場上同時有2隻以上Bad Dreams持有者時應該每一隻各自觸發20傷害（使用者回報：板凳2隻
    // 只發動1次），不是「有這個特性就固定觸發1次」
    const badDreamsHolders = [holderSide.active, ...holderSide.bench].filter(p => p?.abilities?.[0]?.name === 'Bad Dreams');
    for (const badDreamsHolder of badDreamsHolders) {
      if (!(targetSide.active?.status === 'asleep' && targetSide.active.curHp > 0)) break; // 已經被前面某隻打死/換人，沒有目標可打了
      targetSide.active.curHp = Math.max(0, targetSide.active.curHp - 20);
      pocketEmitCardActivation(G, endingRole, badDreamsHolder, '特性觸發：Bad Dreams');
      if (targetSide.active.curHp <= 0) {
        pocketResolveActiveKO(G, targetRole);
        if (G.phase === 'forced_switch' || G.phase === 'done') return true;
      }
    }
  }
  // Quick Growth（2026-08-08新增）：「At the end of your opponent's turn」——持有者在
  // otherSideForCheckup那邊時，endingSide的回合結束正好就是otherSideForCheckup的「對手回合結束」
  if (otherSideForCheckup.active?.abilities?.[0]?.name === 'Quick Growth') {
    const poke = otherSideForCheckup.active;
    const candidates = otherSideForCheckup.deck.map((c, i) => ({ c, i })).filter(({ c }) => c.category === 'Pokemon' && c.evolveFrom === poke.name);
    if (candidates.length) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      otherSideForCheckup.deck.splice(pick.i, 1);
      const preservedDamage = (poke.hp || 0) - (poke.curHp ?? poke.hp ?? 0);
      const preservedEnergy = poke.energy; const preservedUid = poke.uid;
      Object.assign(poke, structuredClone(POCKET_CARDS_BY_ID[pick.c.id]));
      poke.uid = preservedUid; poke.energy = preservedEnergy;
      poke.status = null; poke.poisoned = false; poke.burned = false; // 2026-08-16應使用者要求：進化時異常狀態要清掉
      poke.curHp = Math.max(1, (poke.hp || 0) - preservedDamage);
      poke.boardTurn = G.turnNumber;
      poke._realAbilities = undefined;
      pocketApplyDoubleType(poke);
      otherSideForCheckup.deck = pocketShuffle(otherSideForCheckup.deck);
      pocketEmitCardActivation(G, otherRoleForCheckup, poke, '特性觸發：Quick Growth');
    }
  }
  // Sand Slammer（2026-08-08新增）：跟Snowy Terrain同一類「回合結束觸發、限定主戰位置」，
  // 差別是打對手全場（主戰+板凳）而不是只打主戰
  if (endingAbility === 'Sand Slammer' && endingSide.active.curHp > 0) {
    let anyKO = false;
    for (const p of [otherSideForCheckup.active, ...otherSideForCheckup.bench].filter(Boolean)) {
      p.curHp = Math.max(0, p.curHp - 10);
      if (p.curHp <= 0 && p === otherSideForCheckup.active) anyKO = true;
    }
    pocketEmitCardActivation(G, endingRole, endingSide.active, '特性觸發：Sand Slammer');
    if (anyKO) {
      pocketResolveActiveKO(G, otherRoleForCheckup);
      if (G.phase === 'forced_switch' || G.phase === 'done') return true;
    }
  }
  // Blessed Salt（2026-08-08新增）：回合結束治療己方全體10血，不限主戰/板凳持有，跟Powder Heal
  // （按鈕型特性版本的全體治療）是同一種效果，只是這個是checkup自動觸發
  if ([endingSide.active, ...endingSide.bench].some(p => p?.abilities?.[0]?.name === 'Blessed Salt')) {
    for (const p of [endingSide.active, ...endingSide.bench].filter(Boolean)) p.curHp = Math.min(p.hp, p.curHp + 10);
  }
  // Metal Core Barrier：「在你對手回合結束時棄置」——持有者在otherSideForCheckup那邊
  // （endingRole的回合正要結束，對otherSideForCheckup來說這一刻正好就是「對手回合結束」）
  [otherSideForCheckup.active, ...otherSideForCheckup.bench].filter(Boolean).forEach(p => {
    if (p.tool?.id === 'B2-148') p.tool = null;
  });
  // Deceptive Needle（2026-08-08新增）：惡屬性裝備者在主戰位置時，回合結束對對手主戰造成10傷害
  if (endingSide.active?.tool?.id === 'B4-148' && (endingSide.active.types || []).includes('Darkness') && otherSideForCheckup.active) {
    otherSideForCheckup.active.curHp = Math.max(0, otherSideForCheckup.active.curHp - 10);
    if (otherSideForCheckup.active.curHp <= 0) {
      pocketResolveActiveKO(G, otherRoleForCheckup);
      if (G.phase === 'forced_switch' || G.phase === 'done') return true;
    }
  }
  // Hiking Trail（2026-08-08新增場地卡）：「At the end of each player's turn, that player draws
  // cards until they have 3」——只影響endingSide自己（下一次otherSideForCheckup自己回合結束時
  // 會輪到它），跟Soothing Shore/Rainbow Cave等其餘場地卡checkup效果同一種「只作用在endingSide」寫法
  if (G.activeStadium?.id === 'B2b-069') {
    while (endingSide.hand.length < 3 && endingSide.deck.length) endingSide.hand.push(endingSide.deck.shift());
  }
  // Soothing Shore（2026-08-08新增場地卡）：回合結束治療endingSide身上帶水屬性能量的寶可夢各20血
  if (G.activeStadium?.id === 'B4-154') {
    for (const p of [endingSide.active, ...endingSide.bench].filter(Boolean)) {
      if (p.energy.includes('Water')) p.curHp = Math.min(p.hp, p.curHp + 20);
    }
  }
  // Mismagius（2026-08-08新增delayedDamage機制）：「At the end of your opponent's next turn」
  // ——攻擊當下設defender.delayedDamageUntilTurn = 攻擊時的turnNumber+1，剛好對應defender
  // 自己下一次回合結束時checkup執行的turnNumber，跟Snowy Terrain(每回合觸發)不同，這是一次性的
  if (endingSide.active && endingSide.active.delayedDamageUntilTurn === G.turnNumber) {
    // 花舞鳥「神秘守護」（2026-08-16）：延遲傷害設下當下的攻擊者到引爆時可能已經換場/被擊倒，
    // 沒辦法在這裡重新拿到真正的攻擊者物件，所以改成設下當下就把攻擊者是不是ex存成
    // delayedDamageExOrigin這個布林快照，引爆時直接讀這個快照判斷要不要免疫
    if (!pocketSafeguardImmune(endingSide.active, { ex: endingSide.active.delayedDamageExOrigin })) {
      endingSide.active.curHp = Math.max(0, endingSide.active.curHp - (endingSide.active.delayedDamageAmount || 0));
    }
    if (endingSide.active.curHp <= 0) {
      pocketResolveActiveKO(G, endingRole);
      if (G.phase === 'forced_switch' || G.phase === 'done') return true;
    }
  }
  // Revenge系旗標只維持「緊接著的這一整回合」——endingSide的回合真正結束時清掉，這樣旗標從
  // 「上回合被打死」設成true，到「這回合結束」為止都是true，剛好涵蓋"your opponent's last turn"
  // 語意的那一整個回合，不會一直殘留到更之後的回合
  endingSide.lostToAttackLastOppTurn = false;
  // Wobbuffet（2026-08-08新增）：跟lostToAttackLastOppTurn同一種「維持恰好一整回合」的旗標，
  // 差別是這個只要「被打中」就算（不需要死亡），在pocket_attack的mainDamage>0處設置
  endingSide.tookDamageLastOppTurn = false;
  return false;
}
// 回合真正切換給下一位玩家：turn/turnNumber遞增、抽牌、能量區重新產生、reset本回合限定的
// 旗標、回合開始觸發型被動特性。跟pocketRunCheckup是分開的兩段——checkup只該執行一次，
// 但如果checkup期間發生KO（不管是endingSide自己中毒死亡，還是這裡新增的Snowy Terrain打死
// 對方），中間都要等玩家選完替補寶可夢才能繼續，見pocket_choose_active handler直接呼叫這個
// 函式（不是重新呼叫pocketAdvanceTurn，那樣會讓checkup被重複執行一次）。
function pocketStartNextTurn(G) {
  const endingRole = G.turn;
  G.turn = endingRole === 'p1' ? 'p2' : 'p1';
  G.turnNumber++;
  const side = G[G.turn];
  // 2026-08-08修正：Pocket TCG沒有「牌庫抽完直接落敗」這條規則（跟紙牌版TCG不同），
  // 牌庫空的時候單純不抽牌繼續進行，不判定勝負
  if (side.deck.length > 0) side.hand.push(side.deck.shift());
  // Porygon-Z（2026-08-08新增）：對手指定「下次能量區產生的能量」隨機變成某個屬性——
  // 用一次性欄位覆蓋，套用後立刻清掉，不會持續影響之後每回合的能量產生
  // 2026-08-08再接續：能量預覽——previewEnergy是上一輪就先算好、玩家已經看過的「這回合會拿到
  // 的能量」，這裡直接拿來當真正的pendingEnergy用（不重新roll，不然畫面上先前顯示的預覽會
  // 變成謊話），確保「玩家看到的預覽」永遠等於「實際拿到的」。共用邏輯見pocketProduceEnergy
  // （Rainbow Cave回合中提前觸發同一套規則，2026-08-09抽出共用避免兩處drift）。
  pocketProduceEnergy(side);
  side.energyAttachedThisTurn = false;
  side.retreatedThisTurn = false;
  side.supporterUsedThisTurn = false;
  side.giovanniBoostThisTurn = false;
  side.blaineBoostNamesThisTurn = null;
  side.namedBoostThisTurn = null;
  // Inspiring Dance（2026-08-08新增）：「During YOUR NEXT turn」跟其他ThisTurn旗標（這回合/
  // 對手下回合）不同時機——這裡先把typeBoostNextTurn promote成這回合真正生效的typeBoostThisTurn，
  // 再照舊清空typeBoostNextTurn，跟usedSweetsRelayLastTurn/usedSweetsRelayThisTurn同一種
  // 「先promote再清空」節奏
  side.typeBoostThisTurn = side.typeBoostNextTurn || null;
  side.typeBoostNextTurn = null;
  side.eeveeBoostThisTurn = false;
  side.exOnlyBoostThisTurn = 0;
  side.retreatDiscountThisTurn = 0;
  side.namedCostDiscountThisTurn = null; // Barry（2026-08-07新增）
  side.abilitiesUsedThisTurn = [];
  // Sweets Relay系（2026-08-08新增）：這一刻「自己的新回合開始」，把上次自己那個回合是否用過
  // Sweets Relay promote成LastTurn（供這回合判斷），再清空ThisTurn準備重新記錄
  side.usedSweetsRelayLastTurn = side.usedSweetsRelayThisTurn || false;
  side.usedSweetsRelayThisTurn = false;
  side.stadiumUsedThisTurn = false; // Mesagoza（2026-08-08新增）
  side.irisBonusThisTurn = false; // Iris（2026-08-08新增）
  side.dracoMeteorExtraThisTurn = false; // Drayden（2026-08-08新增，沒被用到的話也要在回合結束後失效）
  // 回合開始觸發型被動特性：Strange Singing——隨機把一隻{P}寶可夢從牌庫放進手牌（"put...into
  // your hand"沒有寫"you may"，是強制觸發，不用暫停等玩家確認）
  if (side.active?.abilities?.[0]?.name === 'Strange Singing') {
    const psychicIdx = side.deck.map((c, i) => ({ c, i })).filter(({ c }) => (c.types || []).includes('Psychic'));
    if (psychicIdx.length) {
      const pick = psychicIdx[Math.floor(Math.random() * psychicIdx.length)];
      side.deck.splice(pick.i, 1);
      side.hand.push(pick.c);
      pocketEmitCardActivation(G, G.turn, side.active, '特性觸發：Strange Singing');
    }
  }
}
function pocketAdvanceTurn(G) {
  if (!pocketRunCheckup(G)) pocketStartNextTurn(G);
}
// 進入強制換人狀態——用佇列而不是單一欄位，讓「雙方主戰同時都需要換人」（見下面
// pocketResolveMutualKO）也能正確依序處理，不會有後呼叫覆蓋前呼叫的問題。
// pendingSwitchRole 維持等於佇列第一位，client端讀的是這個欄位，佇列本身是內部實作細節。
// 2026-08-12新增excludeUid/isKO兩個參數：
// - excludeUid：Sabrina/Drive Off這類「把對手主戰換到板凳、對手自選新主戰」的效果，換下來的
//   那隻會先被push進bench才呼叫這裡，如果對手板凳還有其他選項，不該讓對手選回「剛被換下來的
//   那隻」（使用者：那樣等於卡沒效果）——只有板凳真的只剩它自己一個選項時才放行，見
//   pocket_choose_active handler的驗證。真正KO（死掉進棄牌堆，不是換到板凳）不會用到這個參數。
// - isKO：純粹給client端「等待畫面」用的顯示旗標——區分「對手寶可夢真的倒下了」跟「對手只是
//   被卡片效果強制換人」，兩種文案不一樣（使用者回報Sabrina跳出「寶可夢倒下了」文字是錯的）。
function pocketEnterForcedSwitch(G, koRole, reason, excludeUid = null, isKO = false) {
  G.pendingSwitchQueue = [...(G.pendingSwitchQueue || []).filter(r => r !== koRole), koRole];
  G.phase = 'forced_switch';
  G.pendingSwitchRole = G.pendingSwitchQueue[0];
  G.pendingSwitchReason = reason;
  G.pendingSwitchExcludeUid = excludeUid;
  G.pendingSwitchIsKO = isKO;
}

// 共用的「主戰寶可夢死亡」處理：加分給對方、丟棄、視情況進入forced_switch或判定勝負。
// koRole = 死掉的那隻寶可夢的擁有者。awardPoint=false 用在「非擊倒」的移除情境（例如Aerodactyl
// 「洗回牌庫」、Fan Rotom「擲硬幣放回對手手牌」、Guzzlord「棄置對手主戰」、Liepard「洗回自己牌庫」
// 這幾個ATTACK_EFFECTS——見3292/3549/3604/3707行），這種情況不算KO、不給分，但一樣要走
// 「板凳空了就輸」跟「換人」流程。
// 注意：娜姿(Sabrina/A1-225)不是這種情境——她是純粹的「強制對手換人」，直接操作
// oppSide.active/bench+呼叫pocketEnterForcedSwitch，完全不經過這個函式，跟對手的寶可夢
// 有沒有被擊倒無關（原本這裡的註解誤把娜姿列成這個函式的用例，已更正）。
// 擊倒得分：一般1分、ex 2分、Mega Evolution ex（名字開頭"Mega "且ex，跟Calem判斷同一個
// 慣例）3分——比一般ex更強的獨立分級，不是「ex再加碼」的疊加規則
function pocketKoPoints(dead) {
  if (dead.ex && (dead.name || '').startsWith('Mega ')) return 3;
  return dead.ex ? 2 : 1;
}
function pocketResolveActiveKO(G, koRole, awardPoint = true, endsTurn = true) {
  const koSide = G[koRole];
  const otherRole = koRole === 'p1' ? 'p2' : 'p1';
  const otherSide = G[otherRole];
  const dead = koSide.active;
  // Overlord's Blade（2026-08-08新增）：「during this game」的累積計數，不像其他ThisTurn旗標
  // 會在回合切換時重置——一路累加到對局結束，不管這次KO有沒有真的得分(awardPoint)都算
  koSide.pokemonKnockedOutCount = (koSide.pokemonKnockedOutCount || 0) + 1;
  // Revenge系（2026-08-07新增）：G.turn !== koRole代表這次死亡發生在「對手回合」（被攻擊打死），
  // 不是koRole自己回合結束時的狀態異常checkup死亡（那種情況G.turn === koRole）——只有前者
  // 才算「during your opponent's last turn」，旗標在pocketRunCheckup清除，只維持恰好一整回合
  if (awardPoint && G.turn !== koRole) koSide.lostToAttackLastOppTurn = true;
  // Electrical Cord（2026-08-07新增Tool）：電屬性裝備者在主戰位置被擊倒時，從牠身上的電
  // 能量拿2個各分給1隻板凳寶可夢——要在dead.energy還沒被丟棄前讀取，所以放在最前面處理
  if (dead.tool?.id === 'A3a-065' && (dead.types || []).includes('Lightning') && koSide.bench.length) {
    const lightningIdx = [];
    dead.energy.forEach((e, i) => { if (e === 'Lightning') lightningIdx.push(i); });
    const targets = koSide.bench.slice(0, 2);
    for (let i = 0; i < Math.min(2, lightningIdx.length, targets.length); i++) {
      targets[i].energy.push('Lightning');
    }
  }
  if (awardPoint) {
    otherSide.points += pocketKoPoints(dead);
    // Rescue Scarf（2026-08-07新增Tool）：裝備者被擊倒時進手牌而非棄牌堆，重置成一張全新的卡
    // （化石卡實例當作Pokemon類別放board，理論上也能裝Tool，但這個組合太邊緣，刻意不處理，
    // 維持原本進棄牌堆的行為，避免把Trainer類的化石卡錯誤地當Pokemon卡塞進手牌）
    if (dead.tool?.id === 'A4-155' && !dead.isFossil) {
      Object.assign(dead, {
        curHp: dead.hp, energy: [], tool: null, status: null, boardTurn: null,
        cantAttackUntilTurn: 0, cantRetreatUntilTurn: 0, dmgDebuffUntilTurn: 0, dmgDebuffAmount: 0,
      });
      koSide.hand.push(dead);
    } else {
      koSide.discard.push(dead);
    }
  }
  koSide.active = null;
  if (awardPoint && otherSide.points >= 3) { G.winner = otherRole; G.phase = 'done'; return; }
  if (koSide.bench.length) {
    // endsTurn=false用於特性直接擊倒（pocket_use_ability）——卡面文字沒說「用特性會結束回合」，
    // 只有攻擊/中毒/場地等既有情境才算「這回合的行動已經用掉」，換完人回合還是原本那個人的
    pocketEnterForcedSwitch(G, koRole, endsTurn ? 'endTurn' : 'noEndTurn', null, true); // isKO=true給client顯示「倒下了」
  } else {
    G.winner = otherRole; G.phase = 'done';
  }
}

// 雙方主戰在同一次攻擊中一起陣亡（例如反傷/自傷招式——Golem的Double-Edge打死對手同時50點
// 反傷打死自己——剛好雙殺）。原本攻擊handler對attacker/defender死亡各自獨立呼叫
// pocketResolveActiveKO並各自return，先處理的那個如果導致積分達3就直接判定勝負return，
// 完全沒機會處理第二個死亡（沒加分、沒進forced_switch、陣亡的主戰卡在場上變殭屍）。
// 這裡兩邊的加分/棄牌一次做完，才統一判斷勝負/是否雙方都要換人，避免這個「先死的那個吃光
// return」的bug——跟pokemon_battle.html的bothTeamsWiped()是同一種修法。
function pocketResolveMutualKO(G, roleA, roleB) {
  const info = [roleA, roleB].map(koRole => {
    const koSide = G[koRole];
    const otherRole = koRole === 'p1' ? 'p2' : 'p1';
    const dead = koSide.active;
    koSide.pokemonKnockedOutCount = (koSide.pokemonKnockedOutCount || 0) + 1; // Overlord's Blade，跟pocketResolveActiveKO同一個計數
    G[otherRole].points += pocketKoPoints(dead);
    koSide.discard.push(dead);
    koSide.active = null;
    return { koRole, otherRole, benchEmpty: koSide.bench.length === 0 };
  });
  const p1Win = G.p1.points >= 3, p2Win = G.p2.points >= 3;
  if (p1Win && p2Win) { G.winner = 'draw'; G.phase = 'done'; return; }
  if (p1Win) { G.winner = 'p1'; G.phase = 'done'; return; }
  if (p2Win) { G.winner = 'p2'; G.phase = 'done'; return; }
  const outOfMons = info.filter(i => i.benchEmpty);
  if (outOfMons.length === 2) { G.winner = 'draw'; G.phase = 'done'; return; }
  if (outOfMons.length === 1) { G.winner = outOfMons[0].otherRole; G.phase = 'done'; return; }
  pocketEnterForcedSwitch(G, roleA, 'endTurn', null, true);
  pocketEnterForcedSwitch(G, roleB, 'endTurn', null, true);
}
// 2026-08-12新增：處理「攻擊本身的傷害就把defender/attacker打死，但這次攻擊效果同時又需要
// 玩家自選（ctx.needsChoice）」的情境——例如超級阿勃梭魯ex「黑暗之爪」，80傷害可能直接
// KO對手主戰，但效果本身還要玩家從對手（已公開的）手牌選1張支援者棄掉。原本pocket_attack
// handler是KO分支先return，needsChoice的檢查永遠執行不到，效果整個消失不見（使用者回報
// 「使用招式時不會發動他的效果」）。修法：KO判斷完成後，如果同時有needsChoice，不立刻呼叫
// pocketResolveMutualKO/pocketResolveActiveKO，而是先把「死亡資訊」存進G.pendingChoice.deferredKO，
// 等玩家選完（pocket_attack_choice）才真正執行KO——這裡就是那段「真正執行」邏輯，抽成共用
// 函式讓pocket_attack_choice的多個分支結尾都能呼叫，不用各自重複一份KO判斷。
// 回傳true代表已經處理完並廣播state（呼叫端要接著return，不要再往下走一般的pocketAdvanceTurn）。
function pocketResolveDeferredKO(G, pRoom, deferredKO) {
  if (!deferredKO) return false;
  const { attackerDied, defenderDied, awardPointForDefender, attackerRole, defenderRole } = deferredKO;
  if (attackerDied && defenderDied) {
    pocketResolveMutualKO(G, attackerRole, defenderRole);
    pocketBroadcastState(pRoom);
    return true;
  }
  if (attackerDied) {
    pocketResolveActiveKO(G, attackerRole);
    pocketBroadcastState(pRoom);
    return true;
  }
  if (defenderDied) {
    const attackerSide = G[attackerRole];
    const attacker = attackerSide.active;
    pocketResolveActiveKO(G, defenderRole, awardPointForDefender);
    if (awardPointForDefender && attackerSide.irisBonusThisTurn && attacker?.name === 'Haxorus') attackerSide.points += 1;
    pocketResolveBenchKOs(G, attackerSide, defenderRole);
    pocketBroadcastState(pRoom);
    return true;
  }
  return false;
}
// 板凳寶可夢被濺傷打死（不會觸發forced_switch，因為主戰沒被動到）
function pocketResolveBenchKOs(G, side, otherRole) {
  const otherSide = G[otherRole];
  side.bench = side.bench.filter(p => {
    if (p.curHp > 0) return true;
    side.pokemonKnockedOutCount = (side.pokemonKnockedOutCount || 0) + 1; // Overlord's Blade，跟pocketResolveActiveKO同一個計數
    otherSide.points += pocketKoPoints(p);
    side.discard.push(p);
    return false; // 從板凳移除
  });
}
function pocketCheckWin(G) {
  if (G.p1.points >= 3) { G.winner = 'p1'; G.phase = 'done'; return true; }
  if (G.p2.points >= 3) { G.winner = 'p2'; G.phase = 'done'; return true; }
  return false;
}
// 2026-08-07新增：被動型特性（不用按鈕觸發，只要條件符合就一直生效）——這是跟按鈕觸發/進化
// 觸發/上場觸發完全不同的第四種類型，只做「防禦方減傷/免疫」跟「攻擊方加傷」這兩類，因為
// 它們剛好都只有一個檢查點（mainDamage計算當下），不用額外新增hook。狀態免疫/回合結束觸發/
// 反傷/附加能量觸發這幾類還沒做，需要在更多地方加檢查點，先不擴大範圍。
// 2026-08-07再接續：擴充了「撤退免費/固定減傷/cost+1/被攻擊觸發/回合結束觸發/全域規則」
// 幾類（見下方新函式），仍然沒做的：狀態免疫（Fabled Luster/Insomnia/Flower Shield/Soothing
// Wind，需要先把分散各處的「直接寫status='x'」集中成一個helper才能統一擋）、被KO時觸發
// （Innards Out/Offload Pass/Perish Body/Final Scream/Fade into Darkness，要碰
// pocketResolveActiveKO的計分邏輯，风险更高）、附加能量觸發（Lunar Plumage/Nightmare
// Aura/Comatose/Snoozing Habit/Electromagnetic Wall，要在pocket_attach_energy handler
// 加hook，且Electromagnetic Wall是「對手」附加能量時才觸發，要在對手那側也檢查）、動態HP
// （Toughness Aroma/Infinite Increase，這個引擎的hp欄位目前都是寫死的，跟先前2張場地卡
// 被跳過是同一個理由）——這些留到下次再擴充。
function pocketHasNamed(side, names) {
  return [side.active, ...side.bench].some(p => p && names.includes(p.name));
}
function pocketHasArceus(side) { return pocketHasNamed(side, ['Arceus', 'Arceus ex']); }
// 回傳「這次要扣掉多少傷害」，Infinity代表完全免疫這次攻擊
// Unown的GUARD/POWER特性專用條件：「if you have any Unown in play with an Ability other
// than [這個特性本身]」——場上（不限主戰/板凳）要有另一隻Unown拿著不同的特性才生效，
// 跟持有者自己是不是滿足其他條件無關，GUARD/POWER各自呼叫時傳自己的特性名字排除自己
function pocketUnownConditionMet(side, selfAbilityName) {
  return [side.active, ...side.bench].some(p => p && p.name === 'Unown' && p.abilities?.[0]?.name && p.abilities[0].name !== selfAbilityName);
}
function pocketPassiveDamageReduction(defender, defenderSide, attacker) {
  const ability = defender.abilities?.[0]?.name;
  let reduction = 0;
  switch (ability) {
    case 'Fur Coat': case 'Solid Shell': case 'Exoskeleton': reduction = 20; break;
    case 'Armor': reduction = 30; break;
    case 'Shell Armor': reduction = 10; break;
    case 'Hard Coat': reduction = 20; break;
    // Intimidating Fang原文是「這隻在主戰位置時，對手的攻擊-20」——跟其他「defender自己減傷」
    // 描述角度不同，但數學上結果相同（都是defender.curHp少扣20），這個函式的defender本來就
    // 恆等於defenderSide.active（招式固定打對方主戰，沒有打板凳的招式），可以直接當同一種case處理
    case 'Intimidating Fang': reduction = 20; break;
    case 'Thick Fat': reduction = (attacker.types || []).some(t => t === 'Fire' || t === 'Water') ? 20 : 0; break;
    case 'Resilience Link': reduction = pocketHasArceus(defenderSide) ? 30 : 0; break;
    case 'Ice Face': reduction = defender.curHp === defender.hp ? 40 : 0; break;
    case 'Safeguard': return attacker.ex ? Infinity : 0; // Infinity跟下面的疊加沒有意義，直接短路
    // 2026-08-07新增：機率型防禦——每次呼叫都重新骰一次，這個函式只會被主流程呼叫恰好一次，
    // 不會有骰兩次結果不一致的風險
    case 'Guarded Grill': reduction = Math.random() < 0.5 ? 100 : 0; break;
    case 'Celestial Blessing': case 'Carefree Steps': return Math.random() < 0.5 ? Infinity : 0; // 同上，Infinity直接短路
    case 'Securely Sheltered': reduction = Math.random() < 0.5 ? 80 : 0; break; // 2026-08-08新增：跟Guarded Grill同一種機率型防禦
    // Coordinated Unit：需要「除了defender自己以外，還有另一隻Falinks」才生效，跟其他case
    // 不同的地方是要排除自己（"another"字面意思）
    case 'Coordinated Unit':
      reduction = [defenderSide.active, ...defenderSide.bench].some(p => p && p.name === 'Falinks' && p.uid !== defender.uid) ? 20 : 0;
      break;
    // Disguise：「上場後第一次被攻擊打中」完全免疫，只有一次——用defender.disguiseUsed
    // 這個持久化旗標記錄用過了沒有，跟其他case不同的地方是這裡會直接mutate defender本身
    // （這個函式呼叫端傳的就是真正的物件參照，不是複本，副作用安全）。已知簡化：不會因為
    // 撤退後再上場而重置，一輩子只觸發一次，跟真實規則「每次上場都算一次」不完全相同
    case 'Disguise':
      if (defender.disguiseUsed) return 0;
      defender.disguiseUsed = true;
      return Infinity;
  }
  // GUARD：跟上面switch的「defender自己有沒有這個特性」方向不同，是「defenderSide任一隻Unown
  // 持有GUARD」+場上還有另一隻不同特性的Unown（卡面條件）時，全隊（不限defender自己有沒有
  // 特性）都額外-10，所以用加法疊加在switch算出的reduction之上，不是互斥的另一個case
  if ([defenderSide.active, ...defenderSide.bench].some(p => p?.abilities?.[0]?.name === 'GUARD') &&
      pocketUnownConditionMet(defenderSide, 'GUARD')) reduction += 10;
  return reduction;
}
// 花舞鳥「神秘守護」（Safeguard）：主戰位置被攻擊時，主傷害管線（mainDamage打ctx.defender）
// 會經過pocketPassiveDamageReduction，那裡的'Safeguard' case已經處理過。但這個引擎有大量招式
// 效果是繞過主傷害管線、直接改curHp的「board凳外溢傷害」「多目標傷害」「manually改ctx.defender
// 自己+rawDamage=0」寫法——這些原本完全沒檢查過Safeguard，2026-08-15應使用者回報（花舞鳥在板凳
// 也該免疫對手ex的傷害）補上，統一在這類「直接改curHp」的地方呼叫這個函式判斷要不要跳過扣血。
function pocketSafeguardImmune(target, attacker) {
  return target?.abilities?.[0]?.name === 'Safeguard' && !!attacker?.ex;
}
// 被攻擊打中時（mainDamage>0，不需要死亡）觸發的被動特性——反傷給attacker、讓attacker中毒、
// 或從能量區拿能量附加到板凳。跟pocketPassiveDamageReduction不同，這個不影響傷害數字本身，
// 是「被打中之後」的額外副作用，呼叫端在mainDamage結算完、defender.curHp已扣除之後呼叫。
// 回傳{counterDamage, poisonAttacker, benchEnergyType}供呼叫端套用（呼叫端才有ctx/side可以
// 實際下手改attacker.status/side.pendingEnergy，這個函式只負責判斷「該不該觸發」）。
function pocketPassiveOnHit(defender, defenderSide) {
  const ability = defender.abilities?.[0]?.name;
  const result = { counterDamage: 0, poisonAttacker: false, benchEnergyType: null };
  if (ability === 'Counterattack' || ability === 'Rough Skin' || ability === 'Steel Spikes' || ability === 'Automated Combat') result.counterDamage = 20;
  if (ability === 'Poison Point') result.poisonAttacker = true;
  if (ability === 'Bouncy Body') result.benchEnergyType = 'Water';
  return result;
}
// 「Attacks used by your {F} Pokémon do +30 damage」這種是「持有特性的這隻」給「全隊符合條件的
// 攻擊者」加傷，跟持有者自己是不是正在攻擊無關（Power Link例外，文字是"this Pokémon"限定自己），
// 所以要掃整個攻擊方場上（主戰+板凳）每一隻的特性，不能只看attacker自己身上的特性
function pocketPassiveDamageBonus(attacker, attackerSide) {
  let bonus = 0;
  for (const holder of [attackerSide.active, ...attackerSide.bench]) {
    if (!holder?.abilities?.length) continue;
    const ability = holder.abilities[0].name;
    if (ability === 'Fighting Coach' && (attacker.types || []).includes('Fighting')) bonus += 20;
    if (ability === 'Cursed Metal' && (attacker.types || []).some(t => t === 'Psychic' || t === 'Metal')) bonus += 30;
    if (ability === 'Power Link' && holder.uid === attacker.uid && pocketHasArceus(attackerSide)) bonus += 30;
    // Torrent原文限定「this Pokémon」自己攻擊時才加傷，跟上面幾個「全隊掃描」的case不同，
    // 要另外檢查holder.uid===attacker.uid（跟Power Link的判斷方式一樣）
    if (ability === 'Torrent' && holder.uid === attacker.uid && holder.curHp <= 50) bonus += 60;
    // Coordinated Unit的+20傷害半段——跟pocketPassiveDamageReduction那邊的-20是同一張卡的
    // 兩個方向效果，都要求「除了自己以外還有另一隻Falinks在場」
    if (ability === 'Coordinated Unit' && holder.uid === attacker.uid &&
        [attackerSide.active, ...attackerSide.bench].some(p => p && p.name === 'Falinks' && p.uid !== holder.uid)) bonus += 20;
    // POWER：跟GUARD同一張卡系列，Unown條件（見pocketUnownConditionMet），全隊任何一隻攻擊都+10，
    // 不限holder自己是不是attacker（跟Fighting Coach同一種「全隊掃描」方向）
    if (ability === 'POWER' && pocketUnownConditionMet(attackerSide, 'POWER')) bonus += 10;
    // Lordly Cheering：限定「holder自己在板凳」（不是主戰）才生效，跟其他全隊加傷case剛好
    // 相反——一般case是「持有者不限位置就生效」，這張反過來要求holder不能在主戰位置
    if (ability === 'Lordly Cheering' && attackerSide.bench.some(p => p.uid === holder.uid) && attacker.evolveFrom === 'Poliwhirl') bonus += 40;
  }
  return bonus;
}
// 回傳true代表這次撤退完全免費（Infinity概念用boolean表示更直觀，跟上面的減傷用Infinity不同）
// G參數是2026-08-07擴充Surge Surfer時新增的（需要看場地卡是否存在），呼叫端多傳一個參數
// myFirstTurn：2026-08-07再擴充Wimp Out時新增的第4個參數——「這是我方的第一個回合」，
// 呼叫端用pocketIsFirstTurnFor(pRoom, G, role)算好再傳進來（這個函式本身不知道role/pRoom）
function pocketPassiveFreeRetreat(active, side, G, myFirstTurn) {
  const ability = active.abilities?.[0]?.name;
  if (ability === 'Levitate' && active.energy.length > 0) return true;
  if (ability === 'Speed Link' && pocketHasArceus(side)) return true;
  if (ability === 'Retreat Directive' && active.name === 'Dondozo') return true;
  if (ability === 'Fantastical Floating' && pocketHasNamed(side, ['Latias'])) return true;
  if (ability === 'Surge Surfer' && G?.activeStadium) return true;
  if (ability === 'Wimp Out' && myFirstTurn) return true;
  // Fluffy Flight：跟其他「持有者自己是active才生效」的判斷方向不同——原文「Your Active
  // Pokémon has no Retreat Cost」沒有限定持有者自己要在active，只要牠在場上（板凳也算）
  // 就讓我方主戰免費撤退，所以另外查整個side的特性欄位（不是pocketHasNamed查寶可夢名字，
  // 這裡查的是特性名字，兩者是不同的東西）
  if ([side.active, ...side.bench].some(p => p?.abilities?.[0]?.name === 'Fluffy Flight')) return true;
  return false;
}
// Sky Support是「在板凳上才生效」的被動，讓主戰的基礎寶可夢撤退-1——跟上面幾個「在主戰位置才
// 生效」的被動剛好相反方向，獨立算一個函式比較不會跟active-only的邏輯混在一起搞混
function pocketPassiveBenchRetreatDiscount(active, side) {
  let discount = 0;
  if (active.stage === 'Basic') discount += side.bench.filter(p => p.abilities?.[0]?.name === 'Sky Support').length;
  // Villainous Delivery（2026-08-08新增）：跟Sky Support同一種「板凳上的持有者幫主戰打折」
  // 方向，差別是限定主戰必須是惡屬性，且沒有Sky Support那個「只有基礎階」的限制
  if ((active.types || []).includes('Darkness')) discount += side.bench.filter(p => p.abilities?.[0]?.name === 'Villainous Delivery').length;
  return discount;
}
// Trap Territory：卡面「Your opponent's Active Pokémon's Retreat Cost is 1 more」——跟上面
// discount系列方向相反，是對手場上（不限主戰，板凳也算，卡面沒限定持有者位置）的Ariados
// 讓「我方」主戰撤退+1。呼叫端傳oppSide（對手的side），不是active自己的side
// 2026-08-12新增酋雷姆ex「冰封世界」：跟Trap Territory同一種「對手場上不限位置」的常駐+撤退負擔，
// 差別只在每隻+2不是+1，所以用個別filter().length各自加總，不是共用同一個+1係數
function pocketPassiveRetreatIncrease(oppSide) {
  if (!oppSide) return 0;
  const pool = [oppSide.active, ...oppSide.bench];
  return pool.filter(p => p?.abilities?.[0]?.name === 'Trap Territory').length
    + pool.filter(p => p?.abilities?.[0]?.name === '冰封世界').length * 2;
}
// 「這是role這一方的第一個回合」——turnNumber是全域遞增（1=先攻方第1回合、2=後攻方第1回合、
// 3=先攻方第2回合...），不是每方各自從1開始算，所以「我方第一回合」要看自己是不是先攻方
// 再對應turnNumber===1或===2，兩個地方都要用這個判斷（Wimp Out撤退+Thunderclap Flash回合結束）
function pocketIsFirstTurnFor(pRoom, G, role) {
  return role === pRoom.firstPlayer ? G.turnNumber === 1 : G.turnNumber === 2;
}
// Conductive Body（2026-08-08新增）：跟上面幾個「板凳上的隊友幫忙打折」不同方向——這是
// 持有者自己的撤退成本，條件是「己方場上還有另一隻同名寶可夢」，所以要排除自己(uid)
function pocketPassiveSelfRetreatDiscount(active, side) {
  const ability = active.abilities?.[0]?.name;
  if (ability === 'Conductive Body' && [side.active, ...side.bench].some(p => p && p.uid !== active.uid && p.name === active.name)) return 2;
  return 0;
}
// ctx可選：如果有傳，會把每次擲的結果記進ctx.coinFlips，讓client端可以重播真實的擲硬幣過程
// （而不是只顯示「反正最後結果是這樣」，玩家會覺得動畫跟結果對不上）
// Will（2026-08-08新增）：ctx.G.forceHeadsForRole記錄「誰的下一次擲硬幣必須正面」，用一次
// 就清掉（forceHeadsUsed旗標，不是true/false直接清forceHeadsForRole是因為同一時刻可能有
// 好幾個呼叫點依序執行，用旗標比較不會有「清空後又被其他判斷式誤讀成沒設過」的時序問題）。
// 已知簡化：判斷「這是不是你的擲硬幣」只看role是否匹配，不細分「這是不是真的攻擊/特性/
// 訓練師卡效果」（跟中毒自癒/睡眠甦醒這類自動狀態機制的擲硬幣也會被影響）——真實卡面文字
// 限定後者不算，但要精確區分每個呼叫點的語意分類，投入產出比對1張promo卡太低，因此接受
// 「只要角色對得上就算」這個較寬鬆但簡單的判定。
function pocketFlipCoin(ctx) {
  let r;
  if (ctx?.G && ctx.role != null && ctx.G.forceHeadsForRole === ctx.role && !ctx.G.forceHeadsUsed) {
    r = true;
    ctx.G.forceHeadsUsed = true;
  } else {
    r = Math.random() < 0.5;
  }
  if (ctx) (ctx.coinFlips = ctx.coinFlips || []).push(r);
  return r;
}
function pocketFlipCoins(n, ctx) {
  let h = 0;
  for (let i = 0; i < n; i++) if (pocketFlipCoin(ctx)) h++;
  return h;
}
// side參數（2026-08-08新增，選填，向後相容）：Jungle Totem用——「己方場上有Serperior時，
// 身上每點草能量在付費判定上算2點」，真實規則"provides Energy"只限定用在付費用途，跟其他
// 招式效果讀的"attached Energy"（實際附加數量）是分開兩個概念，所以只改這個函式，不用動
// 任何數energy數量的招式效果（那些讀的是真實附加數量，不受這個特性影響）
function pocketCanPayCost(pokemon, cost, side) {
  const need = {};
  let colorlessNeed = 0;
  for (const t of (cost || [])) {
    if (t === 'Colorless') colorlessNeed++;
    else need[t] = (need[t] || 0) + 1;
  }
  const hasJungleTotem = side && (pokemon.types || []).includes('Grass') &&
    [side.active, ...side.bench].some(p => p?.abilities?.[0]?.name === 'Jungle Totem');
  const have = {};
  for (const e of pokemon.energy) have[e] = (have[e] || 0) + (hasJungleTotem && e === 'Grass' ? 2 : 1);
  // 彩虹能量（FM-005，2026-08-12新增）：裝備時玩家選定的屬性視為額外多1個該屬性能量，只影響
  // 付費計算，不是真的塞進pokemon.energy陣列（energy陣列代表「實體卡上附著的能量」，這個是
  // Tool提供的虛擬加成，道理跟hasJungleTotem的算法位置相同）。
  if (pokemon.tool?.id === 'FM-005' && pokemon.tool.energyType) {
    have[pokemon.tool.energyType] = (have[pokemon.tool.energyType] || 0) + 1;
  }
  for (const t in need) {
    if ((have[t] || 0) < need[t]) return false;
    have[t] -= need[t];
  }
  const leftover = Object.values(have).reduce((a, b) => a + b, 0);
  return leftover >= colorlessNeed;
}
function pocketViewFor(G, role) {
  const op = role === 'p1' ? 'p2' : 'p1';
  // discardEnergy（2026-08-08新增）：沒有卡片可以掛的「純能量」棄牌區（Rainbow Cave等來源），
  // 雙方都是公開資訊（棄牌堆本來就雙方都看得到），所以放進pub()而不是只給you那份
  const pub = side => ({ active: side.active, bench: side.bench, discard: side.discard, discardEnergy: side.discardEnergy || [], points: side.points, deckCount: side.deck.length });
  return {
    turn: G.turn, turnNumber: G.turnNumber, phase: G.phase, winner: G.winner, pendingSwitchRole: G.pendingSwitchRole,
    // 2026-08-12新增：pendingSwitchExcludeUid給client端過濾掉「剛被換下來的那隻」（Sabrina等
    // 效果專用，見pocketEnterForcedSwitch的說明）；pendingSwitchIsKO給等待畫面判斷要不要顯示
    // 「寶可夢倒下了」文字（純卡片效果換人不算倒下，之前錯誤地永遠顯示這句）
    pendingSwitchExcludeUid: G.pendingSwitchExcludeUid || null,
    pendingSwitchIsKO: G.pendingSwitchIsKO || false,
    pendingChoice: G.pendingChoice,
    lastEvent: G.lastEvent,
    cardActivations: G.cardActivations || [], // 卡牌發動顯示（2026-08-08新增），見pocketEmitCardActivation
    // Mesagoza（2026-08-08新增）：activeStadium原本完全沒有送進view，client端沒有任何管道
    // 知道場上有哪張場地卡——這次為了讓Mesagoza的主動觸發按鈕知道「要不要顯示」而補上，
    // 順便修正了「場上有沒有場地卡」這個一直存在但沒被注意到的顯示缺口
    activeStadium: G.activeStadium || null,
    you: {
      ...pub(G[role]), hand: G[role].hand, pendingEnergy: G[role].pendingEnergy,
      previewEnergy: G[role].previewEnergy, // 下回合能量預覽（2026-08-08新增，見pocketStartNextTurn說明）
      energyAttachedThisTurn: G[role].energyAttachedThisTurn, retreatedThisTurn: G[role].retreatedThisTurn,
      energyTypes: G[role].energyTypes, supporterUsedThisTurn: G[role].supporterUsedThisTurn,
      abilitiesUsedThisTurn: G[role].abilitiesUsedThisTurn,
      // 2026-08-06修正：X Speed把retreatDiscountThisTurn設成1，server端算真正的撤退成本時
      // 有正確套用折扣，但這個欄位從來沒有被送進view——client端讀到的永遠是undefined（當0用），
      // 導致畫面上顯示/擋下的撤退成本沒扣到這1點折扣，玩家會覺得「明明用了X Speed，還是撤退不了」。
      retreatDiscountThisTurn: G[role].retreatDiscountThisTurn || 0,
      stadiumUsedThisTurn: G[role].stadiumUsedThisTurn || false, // Mesagoza
    },
    // 2026-08-15新增：對手當前能量區（pendingEnergy，這回合可以拿去裝的那顆能量）是公開資訊，
    // 跟牌庫/棄牌堆一樣雙方都看得到——真實遊戲畫面上對手的能量區本來就是可見的。previewEnergy
    // （下回合才會產生的能量）刻意不送給對手——只有本人自己看得到自己的下一顆能量預覽，這是
    // 既有設計（見you.previewEnergy旁的說明），不是這次要補的缺口。
    opponent: { ...pub(G[op]), handCount: G[op].hand.length, pendingEnergy: G[op].pendingEnergy },
  };
}
/* ── 找own場上（主戰+板凳）某隻寶可夢，供訓練師卡/特性指定目標用 ── */
function pocketFindOwn(side, uid) { return [side.active, ...side.bench].find(p => p && p.uid === uid); }
function pocketFindOwnByName(side, names) { return [side.active, ...side.bench].find(p => p && names.includes(p.name)); }
// Memory Light（2026-08-08新增Tool）：裝備者可以使用「前面所有進化階段」的招式（一路往
// evolveFrom回溯，用name在POCKET_CARDS裡查回每一階的原始卡片資料）。沒裝備這張Tool時原封
// 不動回傳poke.attacks，招式index語意完全不變——這樣pocket_attack讀取msg.attackIndex的地方
// 可以直接無條件換成呼叫這個函式，不用另外判斷「有沒有裝Memory Light」。用seen集合防止
// 進化鏈資料萬一有循環引用時無窮迴圈（理論上不會發生，但防呆成本低）。
// Time Recall（2026-08-08新增）：「Each of your evolved Pokémon can use any attack from its
// previous Evolutions」——跟Memory Light（單一持有者專屬）不同，這是「側」層級的被動：只要
// side上任何一隻有Time Recall，己方全部「已進化」的寶可夢（poke.evolveFrom存在）都能借用
// 前面階段的招式，不限定Time Recall持有者自己。用side參數判斷（呼叫端都能傳），沒傳side
// 的舊call site就只保留Memory Light那條路徑，不影響既有行為
function pocketEffectiveMoves(poke, side) {
  const hasTimeRecall = poke.evolveFrom && side && [side.active, ...(side.bench || [])].some(p => p?.abilities?.[0]?.name === 'Time Recall');
  if (poke.tool?.id !== 'A4a-068' && !hasTimeRecall) return poke.attacks || [];
  const moves = [...(poke.attacks || [])];
  let chainName = poke.evolveFrom;
  const seen = new Set([poke.name]);
  while (chainName && !seen.has(chainName)) {
    seen.add(chainName);
    const prevCard = POCKET_CARDS.find(c => c.category === 'Pokemon' && c.name === chainName);
    if (!prevCard) break;
    moves.push(...(prevCard.attacks || []));
    chainName = prevCard.evolveFrom;
  }
  return moves;
}

/* ── 招式文字效果對照表（Phase 5）──
   key是TCGdex原始英文效果全文（逐字比對，不是regex猜語意，比較不會誤判）。
   handler簽名：(ctx) => void，ctx = { G, role, op, side, oppSide, attacker, defender, atk, rawDamage(可改), extraKO(bool,已內部處理KO時設true讓主流程跳過), healMirror(bool) }
   rawDamage是「弱點加成前」的傷害，函式可以直接改 ctx.rawDamage；weakness會在handler跑完後才加上去。 */
const ATTACK_EFFECTS = {
  /* ── 2026-08-08新增：招式效果長尾第六批(169個)，一次補完剩餘大部分未實作的招式文字 ── */
  /* ── 2026-08-08再接續：回頭補完7個原本skip的長尾（見memory的skip清單），
     Rampardos/Gyarados/Octillery/Ditto/Eldegoss/Meowscarada/Mega Kangaskhan ex ── */
  "If your opponent's Pokémon is Knocked Out by damage from this attack, this Pokémon also does 50 damage to itself.": (ctx) => { ctx.selfDamageIfDefenderKO = 50; },
  // 2026-08-12修正：原本「任意數量」自選被簡化成自動棄置全部符合條件的板凳水系，理由是
  // 「傷害永遠較優、無downside」——但這個判斷忽略了玩家可能有其他理由想留著板凳上的水系
  // 寶可夢（撤退候補/進化素材/其他卡片combo），使用者回報「應該要讓玩家決定要不要，以及要
  // 棄哪幾隻」。base傷害(20)維持不動、正常結算，跟discardForBoost(Vespiquen ex)同一種「固定
  // 基礎傷害+可選加成」模式，只是這裡是「任意數量」(0~全部)而不是固定1隻，所以用新的
  // pick_target_multi_optional（不是既有的pick_target_multi，那個是「剛好選N隻」，這裡的N
  // 由玩家自己決定，一次把整批uid送出，見pocket_attack_choice的解析分支）。
  "You may discard any number of your Benched {W} Pokémon. This attack does 40 more damage for each Benched Pokémon you discarded in this way.": (ctx) => {
    const eligible = ctx.side.bench.filter(p => (p.types || []).includes('Water'));
    if (eligible.length) ctx.needsChoice = { kind: 'pick_target_multi_optional', pool: 'ownBench', eligibleUids: eligible.map(p => p.uid), boostPerPick: 40 };
  },
  "If the Defending Pokémon tries to use an attack, your opponent flips a coin. If tails, that attack doesn't happen. This effect lasts until the Defending Pokémon leaves the Active Spot, and it doesn't stack.": (ctx) => { // Octillery：已知簡化——真實卡面「持續到離開主戰、不疊加」簡化成只鎖對手下一次攻擊嘗試，重用既有attackFlipLockUntilTurn機制
  if (ctx.defender) ctx.defender.attackFlipLockUntilTurn = ctx.G.turnNumber + 1;
},
  "Choose 1 of your Benched Pokémon's attacks, except any Pokémon ex, and use it as this attack. If this Pokémon doesn't have the necessary Energy to use that attack, this attack does nothing.": (ctx) => { // Ditto：借自己板凳(不含ex)任一隻的招式
  const pool = ctx.side.bench.filter(p => !p.ex && p.attacks?.length);
  if (pool.length) ctx.needsChoice = { kind: 'pick_move', pool: 'ownBench', checkEnergy: true };
  else ctx.rawDamage = 0;
},
  "You may shuffle this Pokémon and all attached cards into your deck.": (ctx) => {},
  "This attack is used twice in a row. The second attack does 40 damage.\n(If the first attack Knocks Out your opponent's Active Pokémon, the second attack is used after your opponent chooses a new Active Pokémon.)": (ctx) => { // Mega Kangaskhan ex：已知簡化——「連續使用兩次，若第一次KO則第二次等對手選完替補才打」簡化成同一次結算內直接多打40，KO邊界情況下第二下自然作廢(defender已死)
  if (ctx.defender) ctx.rawDamage += 40;
},
  "Choose a spot from among your opponent's Active Spot and Bench. At the end of your opponent's next turn, do 70 damage to the Pokémon in the spot you chose.": (ctx) => { // Meowscarada：已知簡化——真實卡面是「選一個位置」（含板凳，之後不管誰換上都會被打），這裡簡化成「選定當下那隻寶可夢instance」，跟Mismagius共用同一個delayedDamage機制
  const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
  if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'setDelayedDamage', amount: 70 };
  ctx.rawDamage = 0;
},
  "During your opponent's next turn, this Pokémon takes -20 damage from attacks.": ctx => { ctx.attacker.selfShieldUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfShieldAmount = 20; ctx.attacker.selfShieldCondition = null; },
  "Flip a coin. If heads, during your opponent’s next turn, prevent all damage from—and effects of—attacks done to this Pokémon.": ctx => { if (pocketFlipCoin(ctx)) ctx.attacker.invulnerableUntilTurn = ctx.G.turnNumber + 1; },
  "Switch out your opponent’s Active Pokémon to the Bench. (Your opponent chooses the new Active Pokémon.)": ctx => { // Grapploct：把對手主戰換到板凳（對手自選新主戰），跟Drive Off同一套
    ctx.rawDamage = ctx.rawDamage; // 這張卡本身沒有base damage欄位以外的變化，維持原樣
    if (!ctx.oppSide.active) return;
    const excludedUid = ctx.oppSide.active.uid; // 見Sabrina(A1-225)同一處excludeUid說明
    ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false;
    ctx.oppSide.bench.push(ctx.oppSide.active);
    ctx.oppSide.active = null;
    pocketEnterForcedSwitch(ctx.G, ctx.op, 'noEndTurn', excludedUid);
  },
  "Put 1 random Nidoran♂ from your deck onto your Bench.": ctx => { // Nidoran♀：牌庫隨機1隻Nidoran♂上板凳
    if (ctx.side.bench.length >= 3) return;
    const idxs = ctx.side.deck.map((c, i) => c.name === 'Nidoran♂' ? i : -1).filter(i => i >= 0);
    if (idxs.length) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      const p = ctx.side.deck.splice(i, 1)[0];
      p.curHp = p.hp; p.energy = [];
      ctx.side.bench.push(p);
    }
  },
  "Flip a coin. If heads, discard a random card from your opponent's hand.": ctx => { if (pocketFlipCoin(ctx) && ctx.oppSide.hand.length) ctx.oppSide.hand.splice(Math.floor(Math.random() * ctx.oppSide.hand.length), 1); },
  "If this Pokémon has at least 3 extra {G} Energy attached, this attack does 70 more damage.": ctx => { // Dhelmise：至少3點「額外」草能量（超出招式本身花費）+70
    const have = ctx.attacker.energy.filter(e => e === 'Grass').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Grass').length;
    if (have - need >= 3) ctx.rawDamage += 70;
  },
  "This attack does 50 damage to 1 of your opponent's Benched Pokémon.": ctx => { // Lumineon：50傷害給對手板凳1隻，玩家自選
    const pool = ctx.oppSide.bench;
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 50 };
    ctx.rawDamage = 0;
  },
  "This attack does 10 damage for each of your Benched {L} Pokémon.": ctx => { const n = ctx.side.bench.filter(p => (p.types || []).includes('Lightning')).length; ctx.rawDamage += n * 10; },
  "Put 1 random Koffing from your deck onto your Bench.": ctx => { // Koffing：牌庫隨機1隻同名上板凳
    if (ctx.side.bench.length >= 3) return;
    const idxs = ctx.side.deck.map((c, i) => c.name === 'Koffing' ? i : -1).filter(i => i >= 0);
    if (idxs.length) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      const p = ctx.side.deck.splice(i, 1)[0];
      p.curHp = p.hp; p.energy = [];
      ctx.side.bench.push(p);
    }
  },
  "Shuffle your hand into your deck. Draw a card for each card in your opponent's hand.": ctx => { // Chatot：洗手牌回牌庫，抽跟對手手牌數量一樣多的牌
    const oppCount = ctx.oppSide.hand.length;
    ctx.side.deck = pocketShuffle([...ctx.side.deck, ...ctx.side.hand]);
    ctx.side.hand = [];
    ctx.side.hand.push(...ctx.side.deck.splice(0, Math.min(oppCount, ctx.side.deck.length)));
  },
  "Discard a {L} Energy from this Pokémon.": ctx => { pocketDiscardEnergy(ctx.side, ctx.attacker, 'Lightning', 1); },
  "Discard all {L} Energy from this Pokémon. This attack does 120 damage to 1 of your opponent's Pokémon.": ctx => { // Luxray：棄掉全部電能量，固定120傷害給對手1隻（玩家自選）
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Lightning', ctx.attacker.energy.filter(e => e === 'Lightning').length);
    const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 120 };
    ctx.rawDamage = 0;
  },
  "During your next turn, this Pokémon's Overdrive Smash attack does +60 damage.": ctx => { ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveBuffName = 'Overdrive Smash'; ctx.attacker.moveBuffAmount = 60; },
  "Take a {P} Energy from your Energy Zone and attach it to Mesprit or Azelf.": ctx => { // Uxie：能量區拿1超能力，附給Mesprit或Azelf（不限自己）
    const target = pocketFindOwnByName(ctx.side, ['Mesprit', 'Azelf']);
    if (target) target.energy.push('Psychic');
  },
  "Change the type of the next Energy that will be generated for your opponent to 1 of the following at random: {G}, {R}, {W}, {L}, {P}, {F}, {D}, or {M}.": ctx => { // Porygon-Z：對手下次能量區產生的能量隨機變成其中一種
    const types = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];
    ctx.oppSide.nextEnergyOverride = types[Math.floor(Math.random() * types.length)];
    // 同步更新對手看到的能量預覽，不然玩家畫面上先前顯示的「下回合能量」會跟這張卡改完
    // 之後實際拿到的對不上（見pocketStartNextTurn的previewEnergy說明）
    ctx.oppSide.previewEnergy = ctx.oppSide.nextEnergyOverride;
  },
  "Flip a coin. If heads, put your opponent's Active Pokémon into their hand.": ctx => { // Fan Rotom：coin+把對手主戰放回手牌（不是board，不是棄牌堆）
    if (!pocketFlipCoin(ctx)) { ctx.rawDamage = 0; return; }
    ctx.rawDamage = 0;
    if (!ctx.defender) return;
    const p = ctx.defender;
    p.curHp = p.hp; p.energy = []; p.status = null; p.poisoned = false; p.burned = false; p.boardTurn = null; p.tool = null;
    p.cantAttackUntilTurn = 0; p.cantRetreatUntilTurn = 0; p.dmgDebuffUntilTurn = 0; p.dmgDebuffAmount = 0;
    ctx.oppSide.hand.push(p);
    pocketResolveActiveKO(ctx.G, ctx.op, false);
    ctx.skipMainDamage = true;
  },
  "During your opponent's next turn, attacks used by the Defending Pokémon do −30 damage.": ctx => { if (ctx.defender) { ctx.defender.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; ctx.defender.dmgDebuffAmount = 30; } },
  "During your next turn, this Pokémon's Rolling Spin attack does +60 damage.": ctx => { ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveBuffName = 'Rolling Spin'; ctx.attacker.moveBuffAmount = 60; },
  "Your opponent's Active Pokémon is now Poisoned. Do 20 damage to this Pokémon instead of the usual amount for this Special Condition.": ctx => { if (ctx.defender) { ctx.defender.poisoned = true; ctx.defender.poisonDamageOverride = 20; } },
  "If your opponent's Active Pokémon is a {M} Pokémon, this attack does 30 more damage.": ctx => { if ((ctx.defender?.types || []).includes('Metal')) ctx.rawDamage += 30; },
  "Discard 2 random Energy from this Pokémon.": ctx => { for (let i = 0; i < 2 && ctx.attacker.energy.length; i++) { const [t] = ctx.attacker.energy.splice(Math.floor(Math.random() * ctx.attacker.energy.length), 1); ctx.side.discardEnergy.push(t); } },
  "If your opponent's Active Pokémon is a Pokémon ex, this attack does 30 more damage.": ctx => { if (ctx.defender?.ex) ctx.rawDamage += 30; },
  "Put 1 random Weedle from your deck onto your Bench.": ctx => {
    if (ctx.side.bench.length >= 3) return;
    const idxs = ctx.side.deck.map((c, i) => c.name === 'Weedle' ? i : -1).filter(i => i >= 0);
    if (idxs.length) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      const p = ctx.side.deck.splice(i, 1)[0];
      p.curHp = p.hp; p.energy = [];
      ctx.side.bench.push(p);
    }
  },
  "1 of your opponent's Pokémon is chosen at random. Do 30 damage to it.": ctx => { // Wiglett：隨機挑對手1隻（含板凳），30傷害
    const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
    ctx.rawDamage = 0;
    if (pool.length) {
      const t = pool[Math.floor(Math.random() * pool.length)];
      t.curHp = Math.max(0, t.curHp - 30);
    }
  },
  "Take a {L} Energy from your Energy Zone and attach it to 1 of your Benched  Pokémon.": ctx => { // Pachirisu：能量區拿1電能量，附給自選板凳
    if (ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'attachEnergy', energyType: 'Lightning', count: 1 };
  },
  "This attack also does 20 damage to each of your opponent's Benched Pokémon that has any Energy attached.": ctx => { for (const p of ctx.oppSide.bench) { if (p.energy.length > 0 && !pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 20); } },
  "Flip a coin. If heads, your opponent's Active Pokémon is now Confused.": ctx => { if (pocketFlipCoin(ctx) && ctx.defender) ctx.defender.status = 'confused'; },
  "During your next turn, this Pokémon's Overacceleration attack does +20 damage.": ctx => { ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveBuffName = 'Overacceleration'; ctx.attacker.moveBuffAmount = 20; },
  "If this Pokémon moved from your Bench to the Active Spot this turn, this attack does 60 more damage.": ctx => { if (ctx.attacker.enteredActiveThisTurn === ctx.G.turnNumber) ctx.rawDamage += 60; },
  // 2026-08-13修正：卡面文字明講「Poisoned and Burned」，原本只設了poisoned一半，燒傷被吃掉——
  // 中毒/灼傷改成獨立欄位後可以同時成立，這裡兩個都要設
  "Your opponent's Active Pokémon is now Poisoned and Burned.": ctx => { if (ctx.defender) { ctx.defender.poisoned = true; ctx.defender.burned = true; } },
  "During your opponent's next turn, if this Pokémon is damaged by an attack, do 40 damage to the Attacking Pokémon.": ctx => { ctx.defender && (ctx.defender.retaliateUntilTurn = ctx.G.turnNumber + 1, ctx.defender.retaliateAmount = 40); },
  "Put 1 random Wishiwashi or Wishiwashi ex from your deck onto your Bench.": ctx => {
    if (ctx.side.bench.length >= 3) return;
    const idxs = ctx.side.deck.map((c, i) => ['Wishiwashi', 'Wishiwashi ex'].includes(c.name) ? i : -1).filter(i => i >= 0);
    if (idxs.length) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      const p = ctx.side.deck.splice(i, 1)[0];
      p.curHp = p.hp; p.energy = [];
      ctx.side.bench.push(p);
    }
  },
  "If your opponent's Active Pokémon is a Basic Pokémon, this attack does 60 more damage.": ctx => { if (ctx.defender?.stage === 'Basic') ctx.rawDamage += 60; },
  "Discard 2 {L} Energy from this Pokémon.": ctx => { pocketDiscardEnergy(ctx.side, ctx.attacker, 'Lightning', 2); },
  "Take a {P} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { ctx.attacker.energy.push('Psychic'); },
  "This attack also does 20 damage to 1 of your Pokémon.": ctx => { // Mimikyu：也對自己1隻造成20傷害，玩家自選
    const pool = [ctx.side.active, ...ctx.side.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 20, noEndTurn: false };
  },
  "During your opponent's next turn, this Pokémon takes −50 damage from attacks.": ctx => { ctx.attacker.selfShieldUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfShieldAmount = 50; ctx.attacker.selfShieldCondition = null; },
  "If your opponent's Active Pokémon has more remaining HP than this Pokémon, this attack does 50 more damage.": ctx => { if (ctx.defender && ctx.defender.curHp > ctx.attacker.curHp) ctx.rawDamage += 50; },
  "Discard a random Item card from your opponent's hand.": ctx => { const items = ctx.oppSide.hand.map((c, i) => c.category === 'Trainer' && c.trainerType === 'Item' ? i : -1).filter(i => i >= 0); if (items.length) ctx.oppSide.hand.splice(items[Math.floor(Math.random() * items.length)], 1); },
  "If your opponent's Active Pokémon is affected by a Special Condition, this attack does 60 more damage.": ctx => { if (ctx.defender?.status != null || ctx.defender?.poisoned || ctx.defender?.burned) ctx.rawDamage += 60; },
  "During your opponent's next turn, this Pokémon takes +30 damage from attacks.": ctx => { if (ctx.defender) { ctx.defender.selfVulnUntilTurn = ctx.G.turnNumber + 1; ctx.defender.selfVulnAmount = 30; } },
  "Take a {C} Energy from your Energy Zone and attach it to 1 of your Benched Pokémon.": ctx => { if (ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'attachEnergy', energyType: 'Colorless', count: 1 }; },
  "If your opponent's Active Pokémon is a {D} Pokémon, this attack does 30 more damage.": ctx => { if ((ctx.defender?.types || []).includes('Darkness')) ctx.rawDamage += 30; },
  "During your opponent's next turn, attacks used by the Defending Pokémon cost 1 {C} more, and its Retreat Cost is 1 {C} more.": ctx => { if (ctx.defender) { ctx.defender.costIncreaseUntilTurn = ctx.G.turnNumber + 1; ctx.defender.costIncreaseAmount = 1; ctx.defender.retreatIncreaseUntilTurn = ctx.G.turnNumber + 1; ctx.defender.retreatIncreaseAmount = 1; } },
  "This attack does 70 damage to 1 of your opponent's Pokémon.": ctx => { const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean); if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 70 }; ctx.rawDamage = 0; },
  "If Passimian is on your Bench, this attack does 40 more damage.": ctx => { if ([...ctx.side.bench].some(p => p.name === 'Passimian')) ctx.rawDamage += 40; },
  "Flip 3 coins. For each heads, a card is chosen at random from your opponent's hand. Your opponent reveals that card and shuffles it into their deck.": ctx => { // Krookodile：3枚硬幣，每個正面隨機公開對手1張手牌洗回牌庫
    const heads = pocketFlipCoins(3, ctx);
    for (let i = 0; i < heads; i++) {
      if (!ctx.oppSide.hand.length) break;
      const idx = Math.floor(Math.random() * ctx.oppSide.hand.length);
      const [card] = ctx.oppSide.hand.splice(idx, 1);
      ctx.oppSide.deck.push(card);
    }
    ctx.oppSide.deck = pocketShuffle(ctx.oppSide.deck);
  },
  "Flip 2 coins. If both of them are heads, your opponent's Active Pokémon is Knocked Out.": ctx => { // Bewear：2枚都正面直接歸零defender HP（自然走KO判定，會正常加分）
    ctx.rawDamage = 0;
    const coins = [pocketFlipCoin(ctx), pocketFlipCoin(ctx)];
    if (coins[0] && coins[1] && ctx.defender) ctx.defender.curHp = 0;
  },
  "Your opponent reveals a random card from their hand and shuffles it into their deck.": ctx => { if (ctx.oppSide.hand.length) { const idx = Math.floor(Math.random() * ctx.oppSide.hand.length); const [card] = ctx.oppSide.hand.splice(idx, 1); ctx.oppSide.deck.push(card); ctx.oppSide.deck = pocketShuffle(ctx.oppSide.deck); } },
  "If 1 of your Pokémon used Sweets Relay during your last turn, this attack does 30 more damage.": ctx => { if (ctx.side.usedSweetsRelayLastTurn) ctx.rawDamage += 30; },
  "If 1 of your Pokémon used Sweets Relay during your last turn, this attack does 20 more damage.": ctx => { if (ctx.side.usedSweetsRelayLastTurn) ctx.rawDamage += 20; },
  "Discard all Energy attached to this Pokémon. Your opponent's Active Pokémon is now Paralyzed.": ctx => { ctx.side.discardEnergy.push(...ctx.attacker.energy); ctx.attacker.energy = []; if (ctx.defender) ctx.defender.status = 'paralyzed'; },
  "If 1 of your Pokémon used Sweets Relay during your last turn, this attack does 60 more damage.": ctx => { if (ctx.side.usedSweetsRelayLastTurn) ctx.rawDamage += 60; },
  "Flip a coin. If heads, choose 1 of your opponent's Active Pokémon's attacks and use it as this attack.": ctx => { // Mimikyu：coin+借用對手主戰的招式
    if (!pocketFlipCoin(ctx)) { ctx.rawDamage = 0; return; }
    ctx.rawDamage = 0;
    if (ctx.oppSide.active?.attacks?.length) ctx.needsChoice = { kind: 'pick_move', checkEnergy: false };
  },
  "This attack does 40 damage for each time your Pokémon used Sweets Relay during this game.": ctx => { ctx.rawDamage += (ctx.side.sweetsRelayUseCount || 0) * 40; },
  "Discard all Pokémon Tools from your opponent's Active Pokémon.": ctx => { if (ctx.oppSide.active) ctx.oppSide.active.tool = null; },
  "During your opponent's next turn, if this Pokémon is damaged by an attack, do 30 damage to the Attacking Pokémon.": ctx => { ctx.defender && (ctx.defender.retaliateUntilTurn = ctx.G.turnNumber + 1, ctx.defender.retaliateAmount = 30); },
  "Flip a coin. If tails, this attack does nothing. If heads, your opponent's Active Pokémon is now Paralyzed.": ctx => { if (!pocketFlipCoin(ctx)) { ctx.rawDamage = 0; return; } if (ctx.defender) ctx.defender.status = 'paralyzed'; },
  "This attack does 20 damage for each of your Benched Pokémon.": ctx => { ctx.rawDamage += ctx.side.bench.length * 20; },
  "This attack does 40 more damage for each Energy in your opponent's Active Pokémon's Retreat Cost.": ctx => { const n = (ctx.defender?.retreat || 0); ctx.rawDamage += n * 40; },
  "1 other Pokémon (either yours or your opponent's) is chosen at random 3 times. For each time a Pokémon was chosen, do 50 damage to it.": ctx => { // Magcargo：3次各自隨機挑1隻（雙方場上任一位置皆可），各50傷害
    for (let i = 0; i < 3; i++) {
      const pool = [ctx.side.active, ...ctx.side.bench, ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
      if (!pool.length) break;
      const t = pool[Math.floor(Math.random() * pool.length)];
      t.curHp = Math.max(0, t.curHp - 50);
    }
  },
  "Flip a coin. If tails, discard 2 random Energy from this Pokémon.": ctx => { if (!pocketFlipCoin(ctx)) { for (let i = 0; i < 2 && ctx.attacker.energy.length; i++) { const [t] = ctx.attacker.energy.splice(Math.floor(Math.random() * ctx.attacker.energy.length), 1); ctx.side.discardEnergy.push(t); } } },
  "If your opponent's Active Pokémon is Burned, this attack does 60 more damage.": ctx => { if (ctx.defender?.burned) ctx.rawDamage += 60; },
  "Move all Energy from this Pokémon to 1 of your Benched Pokémon.": ctx => { // Swanna：把自己全部能量移給板凳自選1隻
    if (!ctx.attacker.energy.length || !ctx.side.bench.length) return;
    ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'moveAllEnergyFromAttacker' };
  },
  "This attack also does 10 damage to 1 of your Benched Pokémon.": ctx => { if (ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'damage', amount: 10 }; },
  "This Pokémon is now Asleep. Heal 30 damage from it.": ctx => { ctx.attacker.status = 'asleep'; const before = ctx.attacker.curHp; ctx.attacker.curHp = Math.min(ctx.attacker.hp, ctx.attacker.curHp + 30); ctx.healUid = ctx.attacker.uid; ctx.healAmount = ctx.attacker.curHp - before; },
  "This attack does 20 damage for each Energy attached to your opponent's Active Pokémon.": ctx => { ctx.rawDamage += (ctx.defender?.energy.length || 0) * 20; },
  "If this Pokémon was damaged by an attack during your opponent's last turn while it was in the Active Spot, this attack does 50 more damage.": ctx => { if (ctx.side.tookDamageLastOppTurn) ctx.rawDamage += 50; },
  "Both Active Pokémon are now Asleep.": ctx => { ctx.attacker.status = 'asleep'; if (ctx.defender) ctx.defender.status = 'asleep'; },
  "This attack also does 20 damage to each of your Benched Pokémon.": ctx => { for (const p of ctx.side.bench) p.curHp = Math.max(0, p.curHp - 20); },
  "If this Pokémon moved from your Bench to the Active Spot this turn, this attack does 50 more damage.": ctx => { if (ctx.attacker.enteredActiveThisTurn === ctx.G.turnNumber) ctx.rawDamage += 50; },
  "During your next turn, this Pokémon's Gear Spinner attack does +70 damage.": ctx => { ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveBuffName = 'Gear Spinner'; ctx.attacker.moveBuffAmount = 70; },
  "If your opponent's Active Pokémon is a {G} Pokémon, this attack does 40 more damage.": ctx => { if ((ctx.defender?.types || []).includes('Grass')) ctx.rawDamage += 40; },
  "Flip a coin. If heads, during your opponent's next turn, prevent all damage done to this Pokémon by attacks.": ctx => { if (pocketFlipCoin(ctx)) { ctx.attacker.selfShieldUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfShieldAmount = Infinity; ctx.attacker.selfShieldCondition = null; } },
  "If your opponent's Active Pokémon is an Evolution Pokémon, this attack does 40 more damage.": ctx => { if (ctx.defender && ctx.defender.stage !== 'Basic') ctx.rawDamage += 40; },
  "During your opponent's next turn, attacks used by the Defending Pokémon cost 1 {C} more.": ctx => { if (ctx.defender) { ctx.defender.costIncreaseUntilTurn = ctx.G.turnNumber + 1; ctx.defender.costIncreaseAmount = 1; } },
  "Flip a coin. If tails, this attack does nothing. If heads, during your opponent's next turn, prevent all damage from—and effects of—attacks done to this Pokémon.": ctx => { if (!pocketFlipCoin(ctx)) { ctx.rawDamage = 0; return; } ctx.attacker.invulnerableUntilTurn = ctx.G.turnNumber + 1; },
  "Draw cards until you have the same number of cards in your hand as your opponent.": ctx => { // Aipom：抽牌抽到跟對手手牌數一樣多
    const target = ctx.oppSide.hand.length;
    while (ctx.side.hand.length < target && ctx.side.deck.length) ctx.side.hand.push(ctx.side.deck.shift());
  },
  "If your opponent's Active Pokémon is an evolved Pokémon, devolve it by putting the highest Stage Evolution card on it into your opponent's hand.": ctx => { // Celebi：對手主戰是進化寶可夢時，退化（把現在這張卡放回對手手牌，board換成上一階）
    const defender = ctx.defender;
    if (!defender || defender.stage === 'Basic' || !defender.evolveFrom) return;
    const prevCard = POCKET_CARDS.find(c => c.category === 'Pokemon' && c.name === defender.evolveFrom);
    if (!prevCard) return;
    const currentFormCard = structuredClone(POCKET_CARDS_BY_ID[defender.id]);
    ctx.oppSide.hand.push(currentFormCard);
    const preservedDamage = (defender.hp || 0) - (defender.curHp ?? defender.hp ?? 0);
    const preservedEnergy = defender.energy;
    const preservedUid = defender.uid;
    const preservedTool = defender.tool;
    Object.assign(defender, structuredClone(prevCard));
    defender.uid = preservedUid; defender.energy = preservedEnergy; defender.tool = preservedTool;
    defender.curHp = Math.max(1, (defender.hp || 0) - preservedDamage);
    // 2026-08-08修正：退化後身分變了，pocketSyncAbilitySuppression快取的_realAbilities還是
    // 退化「前」那個物種的特性，要清掉讓它在下次sync時重新抓——不然退化後的正確特性會被
    // 舊快取蓋掉（見同一批修正的完整說明）
    defender._realAbilities = undefined;
    pocketApplyDoubleType(defender);
  },
  "Put 1 random Poliwag from your deck onto your Bench.": ctx => {
    if (ctx.side.bench.length >= 3) return;
    const idxs = ctx.side.deck.map((c, i) => c.name === 'Poliwag' ? i : -1).filter(i => i >= 0);
    if (idxs.length) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      const p = ctx.side.deck.splice(i, 1)[0];
      p.curHp = p.hp; p.energy = [];
      ctx.side.bench.push(p);
    }
  },
  "Discard up to 2 Pokémon Tool cards from your hand. This attack does 50 damage for each card you discarded in this way.": ctx => { // Slowking：棄最多2張手牌Tool卡，各+50傷害（已知簡化：自動棄到上限，不是逐張詢問要不要棄）
    const idxs = ctx.side.hand.map((c, i) => (c.category === 'Trainer' && c.trainerType === 'Tool') ? i : -1).filter(i => i >= 0);
    const toDiscard = idxs.slice(0, 2).sort((a, b) => b - a);
    for (const i of toDiscard) { ctx.side.discard.push(ctx.side.hand.splice(i, 1)[0]); ctx.rawDamage += 50; }
  },
  "If this Pokémon has damage on it, this attack can be used for 1 {L} Energy.": ctx => {},
  "At the end of your opponent's next turn, do 90 damage to the Defending Pokémon.": ctx => { if (ctx.defender) { ctx.defender.delayedDamageUntilTurn = ctx.G.turnNumber + 1; ctx.defender.delayedDamageAmount = 90; ctx.defender.delayedDamageExOrigin = !!ctx.attacker.ex; } },
  "If Latios is on your Bench, this attack does 20 more damage.": ctx => { if (pocketFindOwnByName(ctx.side, ['Latios'])) ctx.rawDamage += 20; },
  "Discard the top card of your deck. If that card is a {F} Pokémon, this attack does 60 more damage.": ctx => { if (ctx.side.deck.length) { const top = ctx.side.deck.shift(); ctx.side.discard.push(top); if (top.category === 'Pokemon' && (top.types || []).includes('Fighting')) ctx.rawDamage += 60; } },
  "If your opponent's Active Pokémon is Zangoose, this attack does 40 more damage.": ctx => { if (ctx.defender?.name === 'Zangoose') ctx.rawDamage += 40; },
  "If this Pokémon has 2 or more different types of Energy attached, this attack does 60 more damage.": ctx => { const types = new Set(ctx.attacker.energy); if (types.size >= 2) ctx.rawDamage += 60; },
  "This attack does 60 damage to 1 of your opponent's Pokémon.": ctx => { const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean); if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 60 }; ctx.rawDamage = 0; },
  "Until this Pokémon leaves the Active Spot, this Pokémon's Rolling Frenzy attack does +30 damage. This effect stacks.": ctx => { // Miltank：疊加式buff直到離開主戰
    if (ctx.attacker.stackBuffName !== 'Rolling Frenzy') { ctx.attacker.stackBuffName = 'Rolling Frenzy'; ctx.attacker.stackBuffAmount = 0; }
    ctx.attacker.stackBuffAmount += 30;
  },
  "Flip a coin. If heads, your opponent's Active Pokémon is now Burned.": ctx => { if (pocketFlipCoin(ctx) && ctx.defender) ctx.defender.burned = true; },
  "Heal 30 damage from each of your Benched Basic Pokémon.": ctx => { for (const p of ctx.side.bench) { if (p.stage === 'Basic') p.curHp = Math.min(p.hp, p.curHp + 30); } },
  "Flip 2 coins. This attack does 30 more damage for each heads.": ctx => { ctx.rawDamage += pocketFlipCoins(2, ctx) * 30; },
  "During your opponent's next turn, if this Pokémon is damaged by an attack, do 20 damage to the Attacking Pokémon.": ctx => { ctx.defender && (ctx.defender.retaliateUntilTurn = ctx.G.turnNumber + 1, ctx.defender.retaliateAmount = 20); },
  "This attack does 10 more damage for each {W} Energy attached to this Pokémon.": ctx => { ctx.rawDamage += ctx.attacker.energy.filter(e => e === 'Water').length * 10; },
  "If you have exactly 2, 4, or 6 cards in your hand, this attack does 30 more damage.": ctx => { if ([2, 4, 6].includes(ctx.side.hand.length)) ctx.rawDamage += 30; },
  "Prevent all damage done to this Pokémon by attacks from Basic Pokémon during your opponent's next turn.": ctx => { ctx.attacker.selfShieldUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfShieldAmount = Infinity; ctx.attacker.selfShieldCondition = 'basic'; },
  "1 of your opponent's Benched Pokémon is chosen at random. This attack also does 20 damage to it.": ctx => { if (ctx.oppSide.bench.length) { const t = ctx.oppSide.bench[Math.floor(Math.random() * ctx.oppSide.bench.length)]; if (!pocketSafeguardImmune(t, ctx.attacker)) t.curHp = Math.max(0, t.curHp - 20); } },
  "If your opponent's Active Pokémon has damage on it, this attack does 30 more damage.": ctx => { if (ctx.defender && ctx.defender.curHp < ctx.defender.hp) ctx.rawDamage += 30; },
  "Discard a {L} Energy from your opponent's Active Pokémon.": ctx => { if (ctx.oppSide.active) pocketDiscardEnergy(ctx.oppSide, ctx.oppSide.active, 'Lightning', 1); },
  "During your opponent's next turn, if they attach Energy from their Energy Zone to the Defending Pokémon, that Pokémon will be Asleep.": ctx => { if (ctx.defender) { ctx.defender.sleepTrapUntilTurn = ctx.G.turnNumber + 1; } },
  "If this Pokémon has damage on it, this attack does 50 more damage.": ctx => { if (ctx.attacker.curHp < ctx.attacker.hp) ctx.rawDamage += 50; },
  "This attack does 20 damage to each of your opponent's Pokémon. During your next turn, this Pokémon's Wild Spin attack does +20 damage to each of your opponent's Pokémon.": ctx => { // Archeops：本次20傷害給對手全場，同名招式下回合再用+20
    ctx.rawDamage = 0;
    const buffed = ctx.attacker.moveBuffUntilTurn === ctx.G.turnNumber && ctx.attacker.moveBuffName === ctx.atk.name;
    const dmg = 20 + (buffed ? 20 : 0);
    if (ctx.defender && !pocketSafeguardImmune(ctx.defender, ctx.attacker)) ctx.defender.curHp = Math.max(0, ctx.defender.curHp - dmg);
    for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - dmg); }
    ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 1;
    ctx.attacker.moveBuffName = ctx.atk.name;
    ctx.attacker.moveBuffAmount = 20;
  },
  "Reveal the top 3 cards of your deck. This attack does 60 damage for each Pokémon with a Retreat Cost of 3 or more you find there. Shuffle the revealed cards back into your deck.": ctx => { // Golurk：翻牌庫頂3張，數撤退成本>=3的寶可夢，各60傷害，洗回
    const top = ctx.side.deck.slice(0, 3);
    const count = top.filter(c => c.category === 'Pokemon' && (c.retreat || 0) >= 3).length;
    ctx.rawDamage += count * 60;
  },
  "If this Pokémon's remaining HP is 30 or less, this attack does 60 more damage.": ctx => { if (ctx.attacker.curHp <= 30) ctx.rawDamage += 60; },
  "If your opponent's Active Pokémon is a {G} Pokémon, this attack does 50 more damage.": ctx => { if ((ctx.defender?.types || []).includes('Grass')) ctx.rawDamage += 50; },
  "Flip a coin. If heads, your opponent reveals their hand. Choose a Supporter card you find there and discard it.": ctx => { // Absol：coin+揭露對手手牌選1張支援者棄置
    if (!pocketFlipCoin(ctx)) return;
    const eligible = ctx.oppSide.hand.filter(c => c.category === 'Trainer' && c.trainerType === 'Supporter');
    ctx.peekOpponentHand = true;
    if (eligible.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppHand', eligibleUids: eligible.map(c => c.uid), action: 'discard' };
  },
  "During your next turn, this Pokémon's Overdrive Smash attack does +30 damage.": ctx => { ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveBuffName = 'Overdrive Smash'; ctx.attacker.moveBuffAmount = 30; },
  "If your opponent's Active Pokémon is Poisoned, this attack does 70 more damage.": ctx => { if (ctx.defender?.poisoned) ctx.rawDamage += 70; },
  "This attack's damage isn't affected by any effects on your opponent's Active Pokémon.": ctx => { ctx.ignoreDefenderEffects = true; },
  "If Durant is on your Bench, this attack does 40 more damage.": ctx => { if (ctx.side.bench.some(p => p.name === 'Durant')) ctx.rawDamage += 40; },
  "Discard 2 {M} Energy from this Pokémon. During your opponent's next turn, this Pokémon takes −50 damage from attacks.": ctx => { // Corviknight：棄2鋼能量+下回合-50
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Metal', 2);
    ctx.attacker.selfShieldUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfShieldAmount = 50; ctx.attacker.selfShieldCondition = null;
  },
  "Flip 2 coins. If both of them are tails, this attack does nothing.": ctx => { const coins = [pocketFlipCoin(ctx), pocketFlipCoin(ctx)]; if (!coins[0] && !coins[1]) ctx.rawDamage = 0; },
  "Heal 40 damage from this Pokémon.": ctx => { const before = ctx.attacker.curHp; ctx.attacker.curHp = Math.min(ctx.attacker.hp, ctx.attacker.curHp + 40); ctx.healUid = ctx.attacker.uid; ctx.healAmount = ctx.attacker.curHp - before; },
  "Flip 2 coins. For each heads, discard a random Energy from your opponent's Active Pokémon. If both of them are tails, this attack does nothing.": ctx => { // Pidgeot：2枚硬幣，每正面棄對手主戰隨機1energy；雙反面則整招無效
    const coins = [pocketFlipCoin(ctx), pocketFlipCoin(ctx)];
    if (!coins[0] && !coins[1]) { ctx.rawDamage = 0; return; }
    const heads = coins.filter(Boolean).length;
    for (let i = 0; i < heads; i++) {
      if (ctx.oppSide.active?.energy.length) {
        const [t] = ctx.oppSide.active.energy.splice(Math.floor(Math.random() * ctx.oppSide.active.energy.length), 1);
        ctx.oppSide.discardEnergy.push(t);
      }
    }
  },
  "Flip 2 coins. This attack does 30 damage for each heads. If this Pokémon has Lucky Mittens attached, flip 4 coins instead.": ctx => { // Ambipom：裝備Lucky Mittens(B1-220)則4枚硬幣，否則2枚，各+30(這裡是設base damage，不是加成，卡面本身沒有damage欄位)
    const n = ctx.attacker.tool?.id === 'B1-220' ? 4 : 2;
    ctx.rawDamage = pocketFlipCoins(n, ctx) * 30;
  },
  "Both Active Pokémon are now Confused.": ctx => { ctx.attacker.status = 'confused'; if (ctx.defender) ctx.defender.status = 'confused'; },
  "Flip a coin until you get tails. This attack does 40 damage for each heads.": ctx => { // Wooloo：連續丟到反面為止，每正面+40
    let heads = 0;
    while (pocketFlipCoin(ctx) && heads < 50) heads++; // 50上限純防呆，避免理論上的無窮迴圈
    ctx.rawDamage += heads * 40;
  },
  "Take 2 {G} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { ctx.attacker.energy.push('Grass', 'Grass'); },
  "If this Pokémon has at least 2 extra {W} Energy attached, this attack also does 50 damage to 1 of your opponent's Benched Pokémon.": ctx => { // Blastoise：至少2點額外水能量，額外50傷害給對手板凳1隻
    const have = ctx.attacker.energy.filter(e => e === 'Water').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Water').length;
    if (have - need >= 2 && ctx.oppSide.bench.length) {
      ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 50 };
    }
  },
  "If this Pokémon has at least 3 extra {W} Energy attached, this attack also does 50 damage to 2 of your opponent's Benched Pokémon.": ctx => { // Mega Blastoise ex：至少3點額外水能量，額外50傷害給對手板凳2隻（選2次）
    const have = ctx.attacker.energy.filter(e => e === 'Water').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Water').length;
    if (have - need >= 3 && ctx.oppSide.bench.length) {
      ctx.needsChoice = { kind: 'pick_target_multi', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), remaining: Math.min(2, ctx.oppSide.bench.length), action: 'damage', amount: 50 };
    }
  },
  "If this Pokémon moved from your Bench to the Active Spot this turn, this attack does 40 more damage.": ctx => { if (ctx.attacker.enteredActiveThisTurn === ctx.G.turnNumber) ctx.rawDamage += 40; },
  "Put a random Supporter card from your deck into your hand.": ctx => { const idxs = ctx.side.deck.map((c, i) => (c.category === 'Trainer' && c.trainerType === 'Supporter') ? i : -1).filter(i => i >= 0); if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); } },
  "Move all {P} Energy from this Pokémon to 1 of your Benched Pokémon.": ctx => { if (ctx.attacker.energy.some(e => e === 'Psychic') && ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'moveAllEnergyFromAttacker', energyFilter: 'Psychic' }; },
  "Heal 20 damage from 1 of your Pokémon.": ctx => { const pool = [ctx.side.active, ...ctx.side.bench].filter(Boolean); if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownAll', eligibleUids: pool.map(p => p.uid), action: 'heal', amount: 20 }; },
  "Your opponent reveals a random card from their hand and shuffles it into their deck. Shuffle this Pokémon into your deck.": ctx => { // Liepard：對手隨機1張手牌洗回牌庫 + 自己洗回牌庫（離場，不算KO不加分）
    if (ctx.oppSide.hand.length) { const idx = Math.floor(Math.random() * ctx.oppSide.hand.length); const [card] = ctx.oppSide.hand.splice(idx, 1); ctx.oppSide.deck.push(card); ctx.oppSide.deck = pocketShuffle(ctx.oppSide.deck); }
    ctx.rawDamage = 0;
    const p = ctx.attacker;
    p.curHp = p.hp; p.energy = []; p.status = null; p.poisoned = false; p.burned = false; p.boardTurn = null; p.tool = null;
    p.cantAttackUntilTurn = 0; p.cantRetreatUntilTurn = 0; p.dmgDebuffUntilTurn = 0; p.dmgDebuffAmount = 0;
    ctx.side.deck.push(p);
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    pocketResolveActiveKO(ctx.G, ctx.role, false);
    ctx.skipMainDamage = true;
  },
  "During your opponent's next turn, this Pokémon has no Weakness.": ctx => { if (ctx.attacker) ctx.attacker.noWeaknessUntilTurn = ctx.G.turnNumber + 1; },
  "During your opponent's next turn, this Pokémon takes  damage from attacks and has no Weakness.": ctx => { if (ctx.attacker) ctx.attacker.noWeaknessUntilTurn = ctx.G.turnNumber + 1; },
  "This attack does 20 more damage for each {M} Energy attached to this Pokémon.": ctx => { ctx.rawDamage += ctx.attacker.energy.filter(e => e === 'Metal').length * 20; },
  "This attack does 20 more damage for each Trainer card in your opponent's deck.": ctx => { const n = ctx.oppSide.deck.filter(c => c.category === 'Trainer').length; ctx.rawDamage += n * 20; },
  "Put 1 random Starly from your deck onto your Bench.": ctx => {
    if (ctx.side.bench.length >= 3) return;
    const idxs = ctx.side.deck.map((c, i) => c.name === 'Starly' ? i : -1).filter(i => i >= 0);
    if (idxs.length) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      const p = ctx.side.deck.splice(i, 1)[0];
      p.curHp = p.hp; p.energy = [];
      ctx.side.bench.push(p);
    }
  },
  "If any of your Pokémon were Knocked Out by damage from an attack during your opponent's last turn, this attack does 40 more damage.": ctx => { if (ctx.side.lostToAttackLastOppTurn) ctx.rawDamage += 40; },
  "This attack's damage isn't affected by Weakness or by any effects on your opponent's Active Pokémon.": ctx => { ctx.ignoreDefenderEffects = true; ctx.ignoreDefenderWeakness = true; },
  "During your opponent's next turn, if this Pokémon is damaged by an attack, do 80 damage to the Attacking Pokémon.": ctx => { ctx.defender && (ctx.defender.retaliateUntilTurn = ctx.G.turnNumber + 1, ctx.defender.retaliateAmount = 80); },
  "Put a random card that evolves from Spewpa from your deck into your hand.": ctx => { const idxs = ctx.side.deck.map((c, i) => (c.category === 'Pokemon' && c.evolveFrom === 'Spewpa') ? i : -1).filter(i => i >= 0); if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); } },
  "During your next turn, attacks used by your Pokémon do +20 damage to your opponent's Active Pokémon.": ctx => { ctx.side.teamMoveBuffUntilTurn = ctx.G.turnNumber + 1; ctx.side.teamMoveBuffAmount = 20; },
  "Flip a coin. If heads, take 2 {R} Energy from your Energy Zone and attach it to 1 of your Benched Pokémon.": ctx => { if (pocketFlipCoin(ctx) && ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'attachEnergy', energyType: 'Fire', count: 2 }; },
  "Flip a coin. If heads, this attack does 70 damage to your opponent's Active Pokémon. If tails, heal 30 damage from your opponent's Active Pokémon.": ctx => { // Delibird：coin，正面70傷害對手主戰，反面幫對手主戰補30血
    ctx.rawDamage = 0;
    if (!ctx.defender) return;
    if (pocketFlipCoin(ctx)) {
      ctx.defender.curHp = Math.max(0, ctx.defender.curHp - 70);
    } else {
      ctx.defender.curHp = Math.min(ctx.defender.hp, ctx.defender.curHp + 30);
    }
  },
  "Discard Water2 {W} Energy from this Pokémon. Your opponent's Active Pokémon is now Paralyzed.": ctx => { // Aurorus：資料"Water2"疑似排版錯誤，判讀成棄2水能量，然後讓對手主戰麻痺
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Water', 2);
    if (ctx.defender) ctx.defender.status = 'paralyzed';
  },
  "Flip a coin. If heads, this attack also does 40 damage to 1 of your opponent's Benched Pokémon.": ctx => { if (pocketFlipCoin(ctx) && ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 40 }; },
  "1 other Pokémon (either yours or your opponent's) is chosen at random 1 time. Do 100 damage to the chosen Pokémon.": ctx => { // Zapdos：雙方任一位置隨機挑1隻，100傷害
    const pool = [ctx.side.active, ...ctx.side.bench, ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
    ctx.rawDamage = 0;
    if (pool.length) { const t = pool[Math.floor(Math.random() * pool.length)]; t.curHp = Math.max(0, t.curHp - 100); }
  },
  "If Plusle is on your Bench, this attack also does 10 damage to each of your opponent's Benched Pokémon.": ctx => { if (pocketFindOwnByName(ctx.side, ['Plusle'])) { for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 10); } } },
  "If you have 5 or more {P} Energy in play, this attack does 60 more damage.": ctx => { const n = [ctx.side.active, ...ctx.side.bench].filter(Boolean).reduce((s, p) => s + p.energy.filter(e => e === 'Psychic').length, 0); if (n >= 5) ctx.rawDamage += 60; },
  "Take 2 {P} Energy from your Energy Zone and attach it to 1 of your Benched {P} Pokémon.": ctx => { const targets = ctx.side.bench.filter(p => (p.types || []).includes('Psychic')); if (targets.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: targets.map(p => p.uid), action: 'attachEnergy', energyType: 'Psychic', count: 2 }; },
  "This attack does 20 more damage for each Supporter card in your discard pile.": ctx => { const n = ctx.side.discard.filter(c => c.category === 'Trainer' && c.trainerType === 'Supporter').length; ctx.rawDamage += n * 20; },
  "Discard a Stadium in play.": ctx => { ctx.G.activeStadium = null; },
  "If this Pokémon has any {P} Energy attached, this attack does 50 more damage.": ctx => { if (ctx.attacker.energy.some(e => e === 'Psychic')) ctx.rawDamage += 50; },
  "Flip a coin. If heads, during your opponent's next turn, this Pokémon takes −100 damage from attacks.": ctx => { if (pocketFlipCoin(ctx)) { ctx.attacker.selfShieldUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfShieldAmount = 100; ctx.attacker.selfShieldCondition = null; } },
  "If this Pokémon has more Energy attached than your opponent's Active Pokémon, this attack does 50 more damage.": ctx => { if (ctx.attacker.energy.length > (ctx.oppSide.active?.energy.length || 0)) ctx.rawDamage += 50; },
  "Flip a coin. If heads, discard your opponent's Active Pokémon.": ctx => { // Guzzlord：coin+棄置對手主戰（不算擊倒不加分）
    if (!pocketFlipCoin(ctx)) { ctx.rawDamage = 0; return; }
    ctx.rawDamage = 0;
    if (!ctx.defender) return;
    ctx.oppSide.discard.push(ctx.defender);
    pocketResolveActiveKO(ctx.G, ctx.op, false);
    ctx.skipMainDamage = true;
  },
  "Until this Pokémon leaves the Active Spot, this Pokémon's Heat-Up Crunch attack does +30 damage. This effect stacks.": ctx => { // Mega Mawile ex：疊加式buff直到離開主戰
    if (ctx.attacker.stackBuffName !== 'Heat-Up Crunch') { ctx.attacker.stackBuffName = 'Heat-Up Crunch'; ctx.attacker.stackBuffAmount = 0; }
    ctx.attacker.stackBuffAmount += 30;
  },
  "During your opponent's next turn, if this Pokémon is in the Active Spot when your opponent's Active Pokémon retreats, this attack does 40 damage to the new Active Pokémon.": ctx => { ctx.attacker.retreatTrapUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.retreatTrapAmount = 40; },
  "During your opponent's next turn, this Pokémon takes −80 damage from attacks from your opponent's Pokémon ex.": ctx => { if (ctx.attacker) { ctx.attacker.selfShieldUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfShieldAmount = 80; ctx.attacker.selfShieldCondition = 'ex'; } },
  "Flip 2 coins. This attack does 40 more damage for each heads.": ctx => { ctx.rawDamage += pocketFlipCoins(2, ctx) * 40; },
  "If a Stadium is in play, this attack does 40 more damage.": ctx => { if (ctx.G.activeStadium) ctx.rawDamage += 40; },
  "Put 3 random cards from among Tandemaus and Maushold from your deck onto your Bench.": ctx => { // Tandemaus：牌庫隨機3隻Tandemaus/Maushold上板凳（板凳空間不足就盡量放）
    let slots = 3 - ctx.side.bench.length;
    for (let n = 0; n < 3 && slots > 0; n++) {
      const idxs = ctx.side.deck.map((c, i) => ['Tandemaus', 'Maushold'].includes(c.name) ? i : -1).filter(i => i >= 0);
      if (!idxs.length) break;
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      const p = ctx.side.deck.splice(i, 1)[0];
      p.curHp = p.hp; p.energy = [];
      ctx.side.bench.push(p);
      slots--;
    }
  },
  "Flip a coin for each Tandemaus and Maushold you have in play. This attack does 60 damage for each heads.": ctx => { // Maushold：每隻場上的Tandemaus/Maushold各丟1枚硬幣，正面各60傷害
    const n = [ctx.side.active, ...ctx.side.bench].filter(p => p && ['Tandemaus', 'Maushold'].includes(p.name)).length;
    ctx.rawDamage += pocketFlipCoins(n, ctx) * 60;
  },
  "If your opponent's Active Pokémon is a Grass or Metal Pokémon, this attack does 40 more damage.": ctx => { if ((ctx.defender?.types || []).some(t => t === 'Grass' || t === 'Metal')) ctx.rawDamage += 40; },
  "During your opponent's next turn, attacks used by the Defending Pokémon cost {C}{C} more.": ctx => { if (ctx.defender) { ctx.defender.costIncreaseUntilTurn = ctx.G.turnNumber + 1; ctx.defender.costIncreaseAmount = 2; } },
  "Flip a coin. If heads, during your opponent's next turn, prevent all damage from and effects of attacks done to this Pokémon.": ctx => { if (pocketFlipCoin(ctx)) ctx.attacker.invulnerableUntilTurn = ctx.G.turnNumber + 1; },
  "This attack also does 50 damage to 1 of your opponent's Benched Pokémon.": ctx => { if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 50 }; },
  "Flip a coin. If heads, the Defending Pokémon is now Paralyzed.": ctx => { if (pocketFlipCoin(ctx) && ctx.defender) ctx.defender.status = 'paralyzed'; },
  "If you have no cards in your deck, this attack can be used for 1 Water Energy.": ctx => {},
  "Discard a Lightning Energy from this Pokémon.": ctx => { pocketDiscardEnergy(ctx.side, ctx.attacker, 'Lightning', 1); },
  "This attack does 20 more damage for each Psychic Pokémon in your discard pile.": ctx => { const n = ctx.side.discard.filter(c => c.category === 'Pokemon' && (c.types || []).includes('Psychic')).length; ctx.rawDamage += n * 20; },
  "If this Pokémon's remaining HP is 60 or less, this attack does nothing.": ctx => { if (ctx.attacker.curHp <= 60) ctx.rawDamage = 0; },
  "If your Pokémon in play have 3 or more different types of Energy attached, this attack does 60 more damage.": ctx => { const types = new Set([ctx.side.active, ...ctx.side.bench].filter(Boolean).flatMap(p => p.energy)); if (types.size >= 3) ctx.rawDamage += 60; },
  "Flip a coin. If tails, this attack does nothing. If heads, during your opponent's next turn, prevent all damage from and effects of attacks done to this Pokémon.": ctx => { if (!pocketFlipCoin(ctx)) { ctx.rawDamage = 0; return; } ctx.attacker.invulnerableUntilTurn = ctx.G.turnNumber + 1; },
  "If you played a Supporter card from your hand during this turn, this attack does 60 more damage.": ctx => { if (ctx.side.supporterUsedThisTurn) ctx.rawDamage += 60; },
  "1 of your opponent's Pokémon is chosen at random for each Metal Energy attached to this Pokémon. For each time a Pokémon was chosen, do 40 damage to it.": ctx => { // Gholdengo：對手隨機挑目標(次數=自己鋼能量數)，各40傷害
    const n = ctx.attacker.energy.filter(e => e === 'Metal').length;
    for (let i = 0; i < n; i++) {
      const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
      if (!pool.length) break;
      const t = pool[Math.floor(Math.random() * pool.length)];
      t.curHp = Math.max(0, t.curHp - 40);
    }
  },
  // Dragonite「流星群」：跟其他隨機打對手場上寶可夢的效果（30damage那兩條）同一種寫法——
  // 差別是這條獨立骰4次、每次都重新從主戰+板凳裡隨機選（可能連續選到同一隻），不是選1隻固定打4次。
  // 這張卡沒有base damage欄位（damage全部來自這個效果本身，等同其他純特效招式的0-dmg慣例）。
  "1 of your opponent's Pokémon is chosen at random 4 times. For each time a Pokémon was chosen, do 50 damage to it.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    // Drayden（2026-08-08新增）：本回合設過旗標的話，這隻Draco Meteor多挑1次——用完即清，
    // 避免殘留到下一次使用這招（跟其他XxxThisTurn旗標一樣，回合結束時pocketStartNextTurn也會重置）
    const picks = ctx.side.dracoMeteorExtraThisTurn ? 5 : 4;
    ctx.side.dracoMeteorExtraThisTurn = false;
    for (let i = 0; i < picks && pool.length; i++) {
      const t = pool[Math.floor(Math.random() * pool.length)];
      t.curHp = Math.max(0, t.curHp - 50);
    }
  },
  "Discard 1 {R} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fire', 1),
  "Discard 2 {P} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.side, ctx.attacker, 'Psychic', 2),
  "Discard 2 {R} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fire', 2),
  "Discard a {R} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fire', 1),
  "Discard all Energy from this Pokémon.": ctx => { ctx.side.discardEnergy.push(...ctx.attacker.energy); ctx.attacker.energy = []; },
  "During your opponent's next turn, the Defending Pokémon can't attack.": ctx => { ctx.defender.cantAttackUntilTurn = ctx.G.turnNumber + 1; },
  "During your opponent's next turn, the Defending Pokémon can't retreat.": ctx => { ctx.defender.cantRetreatUntilTurn = ctx.G.turnNumber + 1; },
  // 2026-08-06修正：原本key用了彎引號’，TCGdex實際卡片文字全部是直引號'，兩者bytes不同
  // 導致這條規則從加入以來從沒真的match過任何卡片（優雅降級=看起來正常運作但其實效果沒生效，
  // 沒有crash所以完全不會被發現）——同一批新增的其他key都是直引號，只有這條手誤打成彎引號。
  "During your opponent's next turn, attacks used by the Defending Pokémon do −20 damage.": ctx => { ctx.defender.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; ctx.defender.dmgDebuffAmount = 20; },
  "Flip 2 coins. This attack does 80 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(2, ctx) * 80; },
  // 2026-08-06修正：原本自動輪流塞給板凳上的火系寶可夢（round-robin），但官方卡面寫的是
  // "in any way you like"——玩家自己選要怎麼分配（含全部塞同一隻）。改成暫停攻擊流程，
  // 進入pendingChoice讓玩家逐張能量點選要給哪隻，詳見pocket_attack handler尾端跟
  // pocket_attack_choice handler。
  "Flip 3 coins. Take an amount of {R} Energy from your Energy Zone equal to the number of heads and attach it to your Benched {R} Pokémon in any way you like.": ctx => {
    const heads = pocketFlipCoins(3, ctx);
    const targets = ctx.side.bench.filter(p => (p.types || []).includes('Fire'));
    if (heads > 0 && targets.length) {
      ctx.needsChoice = { kind: 'energy_distribute', energyQueue: Array(heads).fill('Fire'), eligibleUids: targets.map(p => p.uid) };
    }
    ctx.rawDamage = 0;
  },
  "Flip 4 coins. This attack does 40 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(4, ctx) * 40; },
  "Flip 4 coins. This attack does 50 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(4, ctx) * 50; },
  "Flip a coin. If heads, the Defending Pokémon can't attack during your opponent's next turn.": ctx => { if (pocketFlipCoin(ctx)) ctx.defender.cantAttackUntilTurn = ctx.G.turnNumber + 1; ctx.rawDamage = 0; },
  "Flip a coin. If heads, this attack does 40 more damage.": ctx => { if (pocketFlipCoin(ctx)) ctx.rawDamage += 40; },
  "Flip a coin. If heads, this attack does 40 more damage. If tails, this Pokémon also does 20 damage to itself.": ctx => {
    if (pocketFlipCoin(ctx)) ctx.rawDamage += 40;
    else ctx.selfDamage = (ctx.selfDamage || 0) + 20;
  },
  "Flip a coin. If heads, your opponent shuffles their Active Pokémon into their deck.": ctx => {
    if (!pocketFlipCoin(ctx)) { ctx.rawDamage = 0; return; }
    ctx.rawDamage = 0;
    if (ctx.defender) {
      // 洗回牌庫等同一張全新的卡——傷害/能量/異常狀態都要重置，不然這個物件參照原封不動
      // 塞回deck，之後抽到重新上場時會帶著舊的殘血/能量/中毒狀態，跟真實規則不符
      // （洗進牌庫視為重新變成一張未使用過的卡）。
      const p = ctx.defender;
      p.curHp = p.hp; p.energy = []; p.status = null; p.poisoned = false; p.burned = false; p.boardTurn = null;
      p.cantAttackUntilTurn = 0; p.cantRetreatUntilTurn = 0; p.dmgDebuffUntilTurn = 0; p.dmgDebuffAmount = 0;
      ctx.oppSide.deck.push(p);
      ctx.oppSide.deck = pocketShuffle(ctx.oppSide.deck);
      pocketResolveActiveKO(ctx.G, ctx.op, false);
      ctx.skipMainDamage = true;
    }
  },
  "Flip a coin. If heads, your opponent's Active Pokémon is now Paralyzed.": ctx => { if (pocketFlipCoin(ctx) && ctx.defender) ctx.defender.status = 'paralyzed'; },
  "Flip a coin. If tails, this attack does nothing.": ctx => { if (!pocketFlipCoin(ctx)) ctx.rawDamage = 0; },
  "Heal 30 damage from this Pokémon.": ctx => {
    const before = ctx.attacker.curHp;
    ctx.attacker.curHp = Math.min(ctx.attacker.hp, ctx.attacker.curHp + 30);
    ctx.healUid = ctx.attacker.uid; ctx.healAmount = ctx.attacker.curHp - before;
  },
  "Heal from this Pokémon the same amount of damage you did to your opponent's Active Pokémon.": ctx => { ctx.healMirror = true; },
  "If this Pokémon has at least 2 extra {W} Energy attached, this attack does 60 more damage.": ctx => {
    const have = ctx.attacker.energy.filter(e => e === 'Water').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Water').length;
    if (have - need >= 2) ctx.rawDamage += 60;
  },
  "If your opponent's Active Pokémon is Poisoned, this attack does 50 more damage.": ctx => { if (ctx.defender?.poisoned) ctx.rawDamage += 50; },
  // 2026-08-06修正：原本隨機選一隻板凳換上場，查證卡面文字（沒有"at random"字樣）後
  // 改成玩家自選要換誰上場——暫停進pendingChoice，實際交換動作延到pocket_attack_choice
  // handler收到玩家選擇後才執行。
  "Switch this Pokémon with 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) {
      ctx.needsChoice = { kind: 'bench_switch' };
    }
    ctx.rawDamage = 0;
  },
  "This Pokémon also does 20 damage to itself.": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 20; },
  "This Pokémon also does 50 damage to itself.": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 50; },
  "This attack also does 10 damage to each of your opponent's Benched Pokémon.": ctx => {
    for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 10); }
  },
  // 2026-08-06修正：「1 of your Benched Pokémon」沒有寫"at random"，即使是打在自己板凳上
  // 也是玩家自選要犧牲哪一隻，不能隨機——跟needsChoice的pick_target是同一套（見pocket_attack
  // handler尾端跟pocket_attack_choice handler對pick_target的處理）
  "This attack also does 30 damage to 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'damage', amount: 30 };
  },
  "This attack does 30 damage for each of your Benched {L} Pokémon.": ctx => {
    const n = ctx.side.bench.filter(p => (p.types || []).includes('Lightning')).length;
    ctx.rawDamage = n * 30;
  },
  "This attack does 30 damage to 1 of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 30 };
  },
  "This attack does 30 more damage for each Energy attached to your opponent's Active Pokémon.": ctx => {
    ctx.rawDamage += 30 * (ctx.defender?.energy.length || 0);
  },
  "Your opponent can't use any Supporter cards from their hand during their next turn.": ctx => {
    ctx.oppSide.supporterLockedUntilTurn = ctx.G.turnNumber + 1;
  },
  "Your opponent reveals their hand.": ctx => { ctx.peekOpponentHand = true; },
  "Your opponent's Active Pokémon is now Asleep.": ctx => { if (ctx.defender) ctx.defender.status = 'asleep'; },
  "Your opponent's Active Pokémon is now Poisoned.": ctx => { if (ctx.defender) ctx.defender.poisoned = true; },

  /* ── 2026-08-06新增：A1~B2a全系列擴充後補上的高頻招式效果（依出現次數排序挑選，
     完整133種待實作效果清單記在scratchpad，這裡先做最常見的一批；沒做到的效果文字在
     ATTACK_EFFECTS裡找不到對應key時，doAttack只會照樣打出base傷害、跳過特效，
     不會crash——這是刻意的優雅降級設計，不是漏洞） ── */
  "Flip a coin. If heads, this attack does 20 more damage.": ctx => { if (pocketFlipCoin(ctx)) ctx.rawDamage += 20; },
  "Flip a coin. If heads, this attack does 30 more damage.": ctx => { if (pocketFlipCoin(ctx)) ctx.rawDamage += 30; },
  "Flip a coin. If heads, this attack does 50 more damage.": ctx => { if (pocketFlipCoin(ctx)) ctx.rawDamage += 50; },
  "Flip a coin. If heads, this attack does 60 more damage.": ctx => { if (pocketFlipCoin(ctx)) ctx.rawDamage += 60; },
  "Flip a coin. If heads, this attack does 70 more damage.": ctx => { if (pocketFlipCoin(ctx)) ctx.rawDamage += 70; },
  "Flip a coin. If heads, this attack does 80 more damage.": ctx => { if (pocketFlipCoin(ctx)) ctx.rawDamage += 80; },
  "This Pokémon also does 10 damage to itself.": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 10; },
  "This Pokémon also does 30 damage to itself.": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 30; },
  "This Pokémon also does 70 damage to itself.": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 70; },
  "Flip a coin. If tails, this Pokémon also does 30 damage to itself.": ctx => { if (!pocketFlipCoin(ctx)) ctx.selfDamage = (ctx.selfDamage || 0) + 30; },
  "Your opponent's Active Pokémon is now Confused.": ctx => { if (ctx.defender) ctx.defender.status = 'confused'; },
  "Your opponent's Active Pokémon is now Burned.": ctx => { if (ctx.defender) ctx.defender.burned = true; },
  "This Pokémon is now Asleep.": ctx => { ctx.attacker.status = 'asleep'; },
  "This Pokémon is now Confused.": ctx => { ctx.attacker.status = 'confused'; },
  "Flip a coin. If heads, your opponent's Active Pokémon is now Paralyzed. If tails, your opponent's Active Pokémon is now Confused.": ctx => {
    if (!ctx.defender) return;
    ctx.defender.status = pocketFlipCoin(ctx) ? 'paralyzed' : 'confused';
  },
  // 5種異常狀態隨機選1種套用——文字本身就是「隨機」，不是玩家可選，跟其他random-target效果同一套寫法
  "1 Special Condition from among Asleep, Burned, Confused, Paralyzed, and Poisoned is chosen at random, and your opponent's Active Pokémon is now affected by that Special Condition. Any Special Conditions already affecting that Pokémon will not be chosen.": ctx => {
    if (!ctx.defender) return;
    const conditions = ['asleep', 'burned', 'confused', 'paralyzed', 'poisoned'].filter(s => !pocketHasCondition(ctx.defender, s));
    pocketSetCondition(ctx.defender, conditions[Math.floor(Math.random() * conditions.length)]);
  },
  // 自身防禦盾——沿用既有dmgDebuffUntilTurn/dmgDebuffAmount欄位機制，但蓋在自己(attacker)身上
  // 而不是對手身上：doAttack主傷害計算本來就是看「這次被打的那隻」有沒有這個欄位命中當前回合數，
  // 蓋在自己身上=下回合被打時會命中減傷，語意上正確對應「這隻寶可夢下回合受到的傷害-20/-30」。
  "During your opponent's next turn, this Pokémon takes −20 damage from attacks.": ctx => {
    ctx.attacker.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.dmgDebuffAmount = 20;
  },
  "During your opponent's next turn, this Pokémon takes −30 damage from attacks.": ctx => {
    ctx.attacker.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.dmgDebuffAmount = 30;
  },
  // 「防止下回合受到的所有傷害跟效果」——用新的invulnerableUntilTurn旗標，pocket_attack
  // handler開頭已經加了短路檢查，這裡只要負責設旗標
  "Flip a coin. If heads, during your opponent's next turn, prevent all damage from—and effects of—attacks done to this Pokémon.": ctx => {
    if (pocketFlipCoin(ctx)) ctx.attacker.invulnerableUntilTurn = ctx.G.turnNumber + 1;
  },
  "Heal 10 damage from this Pokémon.": ctx => {
    const before = ctx.attacker.curHp;
    ctx.attacker.curHp = Math.min(ctx.attacker.hp, ctx.attacker.curHp + 10);
    ctx.healUid = ctx.attacker.uid; ctx.healAmount = ctx.attacker.curHp - before;
  },
  "Heal 20 damage from this Pokémon.": ctx => {
    const before = ctx.attacker.curHp;
    ctx.attacker.curHp = Math.min(ctx.attacker.hp, ctx.attacker.curHp + 20);
    ctx.healUid = ctx.attacker.uid; ctx.healAmount = ctx.attacker.curHp - before;
  },
  "Draw a card.": ctx => { if (ctx.side.deck.length) ctx.side.hand.push(ctx.side.deck.shift()); },
  // 2026-08-11修正：這3個「also does N damage to 1 of your opponent's Benched Pokémon」
  // 原本用Math.random()隨機選板凳目標，但卡面文字沒有「at random」——包含Raikou ex
  // 「Voltaic Bullet」在內，改成跟已經正確實作的50傷害版本(3816行)同一套needsChoice流程，
  // 讓玩家自己選要打哪一隻（見feedback_pocket_effect_choice_not_random既有慣例）
  "This attack also does 20 damage to 1 of your opponent's Benched Pokémon.": ctx => {
    if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 20 };
  },
  "This attack also does 10 damage to 1 of your opponent's Benched Pokémon.": ctx => { // Raikou ex「Voltaic Bullet」
    if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 10 };
  },
  "This attack also does 30 damage to 1 of your opponent's Benched Pokémon.": ctx => {
    if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 30 };
  },
  "This attack also does 20 damage to each of your opponent's Benched Pokémon.": ctx => {
    for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 20); }
  },
  // 2026-08-11修正：這4個「does N damage to 1 of your opponent's Pokémon」（含主戰/板凳任一隻）
  // 原本用Math.random()隨機選，卡面沒有「at random」——改成跟70/60傷害版本（3531/3636行）
  // 同一套needsChoice，玩家自己選要打誰
  "This attack does 50 damage to 1 of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 50 };
  },
  "This attack does 40 damage to 1 of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 40 };
  },
  "This attack does 20 damage to 1 of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 20 };
  },
  "This attack does 10 damage to 1 of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 10 };
  },
  "This attack does 20 damage to 1 of your opponent's Benched Pokémon.": ctx => {
    ctx.rawDamage = 0;
    if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 20 };
  },
  "This attack does 20 more damage for each Energy attached to your opponent's Active Pokémon.": ctx => {
    ctx.rawDamage += 20 * (ctx.defender?.energy.length || 0);
  },
  "This attack does 20 more damage for each of your Benched Pokémon.": ctx => { ctx.rawDamage += 20 * ctx.side.bench.length; },
  "This attack does 30 more damage for each of your Benched Pokémon.": ctx => { ctx.rawDamage += 30 * ctx.side.bench.length; },
  "This attack does 20 more damage for each of your opponent's Benched Pokémon.": ctx => { ctx.rawDamage += 20 * ctx.oppSide.bench.length; },
  "This attack does 20 more damage for each Energy attached to this Pokémon.": ctx => { ctx.rawDamage += 20 * (ctx.attacker.energy?.length || 0); },
  "This attack does 20 damage for each Benched Pokémon (both yours and your opponent's).": ctx => {
    ctx.rawDamage = 20 * (ctx.side.bench.length + ctx.oppSide.bench.length);
  },
  "Flip 2 coins. This attack does 20 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(2, ctx) * 20; },
  "Flip 2 coins. This attack does 30 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(2, ctx) * 30; },
  "Flip 2 coins. This attack does 50 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(2, ctx) * 50; },
  "Flip 3 coins. This attack does 10 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(3, ctx) * 10; },
  "Flip 3 coins. This attack does 20 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(3, ctx) * 20; },
  "Flip 3 coins. This attack does 40 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(3, ctx) * 40; },
  "Flip 3 coins. This attack does 60 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(3, ctx) * 60; },
  // 「翻到反面才停」——用while迴圈持續丟，跟既有pocketFlipCoin(ctx)同一套會自動記錄進
  // ctx.coinFlips的機制，client端動畫會照實際丟的次數全部播出來
  "Flip a coin until you get tails. This attack does 20 damage for each heads.": ctx => {
    let heads = 0;
    while (pocketFlipCoin(ctx)) heads++;
    ctx.rawDamage = heads * 20;
  },
  "Flip a coin until you get tails. This attack does 40 more damage for each heads.": ctx => {
    let heads = 0;
    while (pocketFlipCoin(ctx)) heads++;
    ctx.rawDamage += heads * 40;
  },
  "Flip a coin until you get tails. For each heads, discard a random Energy from your opponent's Active Pokémon.": ctx => {
    let heads = 0;
    while (pocketFlipCoin(ctx)) heads++;
    for (let i = 0; i < heads && ctx.defender?.energy.length; i++) {
      const [t] = ctx.defender.energy.splice(Math.floor(Math.random() * ctx.defender.energy.length), 1);
      ctx.oppSide.discardEnergy.push(t);
    }
  },
  "During your next turn, this Pokémon can't attack.": ctx => { ctx.attacker.cantAttackUntilTurn = ctx.G.turnNumber + 1; },
  "Flip a coin. If tails, during your next turn, this Pokémon can't attack.": ctx => {
    if (!pocketFlipCoin(ctx)) ctx.attacker.cantAttackUntilTurn = ctx.G.turnNumber + 1;
  },
  "Flip a coin. If heads, discard a random Energy from your opponent's Active Pokémon.": ctx => {
    if (pocketFlipCoin(ctx) && ctx.defender?.energy.length) {
      const [t] = ctx.defender.energy.splice(Math.floor(Math.random() * ctx.defender.energy.length), 1);
      ctx.oppSide.discardEnergy.push(t);
    }
  },
  "Discard a random Energy from your opponent's Active Pokémon.": ctx => {
    if (ctx.defender?.energy.length) { const [t] = ctx.defender.energy.splice(Math.floor(Math.random() * ctx.defender.energy.length), 1); ctx.oppSide.discardEnergy.push(t); }
  },
  "Discard a random Energy from this Pokémon.": ctx => {
    if (ctx.attacker.energy.length) { const [t] = ctx.attacker.energy.splice(Math.floor(Math.random() * ctx.attacker.energy.length), 1); ctx.side.discardEnergy.push(t); }
  },
  "Discard a random Energy from both Active Pokémon.": ctx => {
    if (ctx.attacker.energy.length) { const [t1] = ctx.attacker.energy.splice(Math.floor(Math.random() * ctx.attacker.energy.length), 1); ctx.side.discardEnergy.push(t1); }
    if (ctx.defender?.energy.length) { const [t2] = ctx.defender.energy.splice(Math.floor(Math.random() * ctx.defender.energy.length), 1); ctx.oppSide.discardEnergy.push(t2); }
  },
  "Discard a {R}, {W}, and {L} Energy from this Pokémon.": ctx => {
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fire', 1); pocketDiscardEnergy(ctx.side, ctx.attacker, 'Water', 1); pocketDiscardEnergy(ctx.side, ctx.attacker, 'Lightning', 1);
  },
  "Discard all {R} Energy from this Pokémon.": ctx => { pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fire', ctx.attacker.energy.filter(e => e === 'Fire').length); },
  "Discard a {F} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fighting', 1),
  "Discard 3 {R} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fire', 3),
  "Take a {L} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { ctx.attacker.energy.push('Lightning'); },
  "Take 3 {R} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { for (let i = 0; i < 3; i++) ctx.attacker.energy.push('Fire'); },
  // 2026-08-06修正（使用者第二次糾正同一個問題）：「attach it to 1 of your Benched Pokémon」
  // 沒有寫"at random"，是玩家自己選要附加給哪一隻板凳，不是隨機——之前的判斷準則「沒寫choose/
  // in any way you like就隨機挑」是錯的，真實規則裡只有明確寫"at random"/"is chosen at random"
  // 才是真隨機，其餘「1 of your X」語法一律是操作方自選。詳見memory feedback_pocket_effect_
  // choice_not_random。改用needsChoice的pick_target暫停讓玩家選，跟bench_switch/
  // energy_distribute同一套pocket_attack_choice流程。
  "Take a {R} Energy from your Energy Zone and attach it to 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'attachEnergy', energyType: 'Fire', count: 1 };
  },
  "Take a {L} Energy from your Energy Zone and attach it to 1 of your Benched Basic Pokémon.": ctx => {
    const targets = ctx.side.bench.filter(p => p.stage === 'Basic');
    if (targets.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: targets.map(p => p.uid), action: 'attachEnergy', energyType: 'Lightning', count: 1 };
  },
  "Take a {R} Energy from your Energy Zone and attach it to 1 of your Benched Basic Pokémon.": ctx => {
    const targets = ctx.side.bench.filter(p => p.stage === 'Basic');
    if (targets.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: targets.map(p => p.uid), action: 'attachEnergy', energyType: 'Fire', count: 1 };
  },
  "Take a {W} Energy from your Energy Zone and attach it to 1 of your Benched Basic Pokémon.": ctx => {
    const targets = ctx.side.bench.filter(p => p.stage === 'Basic');
    if (targets.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: targets.map(p => p.uid), action: 'attachEnergy', energyType: 'Water', count: 1 };
  },
  "Take 2 {M} Energy from your Energy Zone and attach it to 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'attachEnergy', energyType: 'Metal', count: 2 };
  },
  "Put a random Pokémon from your deck into your hand.": ctx => {
    const idxs = ctx.side.deck.map((c, i) => c.category === 'Pokemon' ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); }
  },
  "Put 1 random Basic Pokémon from your deck onto your Bench.": ctx => {
    if (ctx.side.bench.length >= 3) return;
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Pokemon' && c.stage === 'Basic') ? i : -1).filter(i => i >= 0);
    if (idxs.length) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      const p = ctx.side.deck.splice(i, 1)[0];
      p.curHp = p.hp; p.energy = [];
      ctx.side.bench.push(p);
    }
  },
  "Discard the top card of your opponent's deck.": ctx => { if (ctx.oppSide.deck.length) ctx.oppSide.discard.push(ctx.oppSide.deck.shift()); },
  "Discard the top 3 cards of your opponent's deck.": ctx => { ctx.oppSide.discard.push(...ctx.oppSide.deck.splice(0, 3)); },
  "Discard a random card from your opponent's hand.": ctx => {
    if (ctx.oppSide.hand.length) ctx.oppSide.hand.splice(Math.floor(Math.random() * ctx.oppSide.hand.length), 1);
  },
  "Discard a card from your hand. If you can't, this attack does nothing.": ctx => {
    if (!ctx.side.hand.length) { ctx.rawDamage = 0; return; }
    ctx.side.hand.splice(Math.floor(Math.random() * ctx.side.hand.length), 1);
  },
  "This attack's damage isn't affected by Weakness.": ctx => { ctx.ignoreWeakness = true; },
  "This attack does more damage equal to the damage this Pokémon has on it.": ctx => {
    const dmgOn = (ctx.attacker.hp || 0) - (ctx.attacker.curHp || 0);
    ctx.rawDamage += Math.max(0, dmgOn);
  },
  "If this Pokémon has damage on it, this attack does 60 more damage.": ctx => {
    if ((ctx.attacker.curHp ?? ctx.attacker.hp) < ctx.attacker.hp) ctx.rawDamage += 60;
  },
  "If your opponent's Active Pokémon has damage on it, this attack does 40 more damage.": ctx => {
    if (ctx.defender && (ctx.defender.curHp ?? ctx.defender.hp) < ctx.defender.hp) ctx.rawDamage += 40;
  },
  "If your opponent's Active Pokémon has damage on it, this attack does 60 more damage.": ctx => {
    if (ctx.defender && (ctx.defender.curHp ?? ctx.defender.hp) < ctx.defender.hp) ctx.rawDamage += 60;
  },
  "If your opponent's Active Pokémon is Poisoned, this attack does 60 more damage.": ctx => { if (ctx.defender?.poisoned) ctx.rawDamage += 60; },
  "If this Pokémon evolved during this turn, this attack does 20 more damage.": ctx => {
    if (ctx.attacker.boardTurn === ctx.G.turnNumber) ctx.rawDamage += 20;
  },
  "If this Pokémon has at least 1 extra {W} Energy attached, this attack does 40 more damage.": ctx => {
    const have = ctx.attacker.energy.filter(e => e === 'Water').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Water').length;
    if (have - need >= 1) ctx.rawDamage += 40;
  },
  "If this Pokémon has any {W} Energy attached, this attack does 40 more damage.": ctx => {
    if (ctx.attacker.energy.includes('Water')) ctx.rawDamage += 40;
  },
  "If this Pokémon has at least 2 extra {F} Energy attached, this attack does 50 more damage.": ctx => {
    const have = ctx.attacker.energy.filter(e => e === 'Fighting').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Fighting').length;
    if (have - need >= 2) ctx.rawDamage += 50;
  },
  "If this Pokémon has at least 2 extra {F} Energy attached, this attack does 60 more damage.": ctx => {
    const have = ctx.attacker.energy.filter(e => e === 'Fighting').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Fighting').length;
    if (have - need >= 2) ctx.rawDamage += 60;
  },
  "If this Pokémon has at least 2 extra {R} Energy attached, this attack does 60 more damage.": ctx => {
    const have = ctx.attacker.energy.filter(e => e === 'Fire').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Fire').length;
    if (have - need >= 2) ctx.rawDamage += 60;
  },
  "If this Pokémon has at least 3 extra {W} Energy attached, this attack does 70 more damage.": ctx => {
    const have = ctx.attacker.energy.filter(e => e === 'Water').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Water').length;
    if (have - need >= 3) ctx.rawDamage += 70;
  },
  "If your opponent's Active Pokémon is a Pokémon ex, this attack does 70 more damage.": ctx => { if (ctx.defender?.ex) ctx.rawDamage += 70; },
  "Halve your opponent's Active Pokémon's remaining HP, rounded down.": ctx => {
    ctx.rawDamage = 0;
    if (ctx.defender) ctx.defender.curHp = Math.floor((ctx.defender.curHp ?? ctx.defender.hp) / 2);
  },
  "Switch out your opponent's Active Pokémon to the Bench. (Your opponent chooses the new Active Pokémon.)": ctx => {
    if (!ctx.oppSide.bench.length || !ctx.defender) return;
    ctx.oppSide.bench.push(ctx.defender);
    ctx.oppSide.active = null;
    ctx.forceOpponentSwitch = true;
  },
  "You may switch this Pokémon with 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) ctx.needsChoice = { kind: 'bench_switch' };
  },
  "1 of your opponent's Pokémon is chosen at random 3 times. For each time a Pokémon was chosen, do 50 damage to it.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    for (let i = 0; i < 3 && pool.length; i++) {
      const t = pool[Math.floor(Math.random() * pool.length)];
      t.curHp = Math.max(0, t.curHp - 50);
    }
  },
  "1 of your opponent's Benched Pokémon is chosen at random 3 times. For each time a Pokémon was chosen, also do 20 damage to it.": ctx => {
    if (!ctx.oppSide.bench.length) return;
    for (let i = 0; i < 3; i++) {
      const t = ctx.oppSide.bench[Math.floor(Math.random() * ctx.oppSide.bench.length)];
      t.curHp = Math.max(0, t.curHp - 20);
    }
  },
  "This attack does 20 damage to each of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    if (ctx.defender && !pocketSafeguardImmune(ctx.defender, ctx.attacker)) ctx.defender.curHp = Math.max(0, ctx.defender.curHp - 20);
    for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 20); }
  },

  /* ── 2026-08-06第二批新增：修完彎引號bug後，依出現頻率繼續補高頻效果 ── */
  "This attack does 30 damage to 1 of your opponent's Benched Pokémon.": ctx => {
    ctx.rawDamage = 0;
    if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 30 };
  },
  // 新機制：攻擊前擲硬幣，反面攻擊直接失敗——旗標蓋在「被打的那隻」身上，實際檢查在
  // pocket_attack handler最前面（跟paralyzed/asleep同一批前置檢查）
  "During your opponent's next turn, if the Defending Pokémon tries to use an attack, your opponent flips a coin. If tails, that attack doesn't happen.": ctx => {
    ctx.defender.attackFlipLockUntilTurn = ctx.G.turnNumber + 1;
  },
  // 新機制：道具卡封鎖——蓋在對方side上，pocket_play_item/pocket_play_supporter handler檢查
  "During your opponent's next turn, they can't play any Item cards from their hand.": ctx => {
    ctx.oppSide.itemLockedUntilTurn = ctx.G.turnNumber + 1;
  },
  // 新機制：能量鎖定——只封鎖附加到「主戰位置」，卡面原文只講Active Pokémon，板凳不受影響
  "During your opponent's next turn, they can't take any Energy from their Energy Zone to attach to their Active Pokémon.": ctx => {
    ctx.oppSide.energyLockedUntilTurn = ctx.G.turnNumber + 1;
  },
  // 三種不同屬性能量、玩家自選怎麼分配——沿用既有energy_distribute的needsChoice流程，
  // 把energyQueue從單一屬性重複N次，改成三種屬性各1個排成隊列
  "Take a {R}, {W}, and {L} Energy from your Energy Zone and attach them to your Benched Basic Pokémon in any way you like.": ctx => {
    const targets = ctx.side.bench.filter(p => p.stage === 'Basic');
    if (targets.length) {
      ctx.needsChoice = { kind: 'energy_distribute', energyQueue: ['Fire', 'Water', 'Lightning'], eligibleUids: targets.map(p => p.uid) };
    }
    ctx.rawDamage = 0;
  },
  "Put 1 random {G} Pokémon from your deck into your hand.": ctx => {
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Pokemon' && (c.types || []).includes('Grass')) ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); }
  },
  "Flip a coin for each Energy attached to this Pokémon. This attack does 50 damage for each heads.": ctx => {
    ctx.rawDamage = pocketFlipCoins(ctx.attacker.energy.length, ctx) * 50;
  },
  "Discard a random Energy from among the Energy attached to all Pokémon (both yours and your opponent's).": ctx => {
    pocketDiscardRandomEnergyInPlay(ctx.G, 1);
  },
  "Discard 2 random Energy from among the Energy attached to all Pokémon (both yours and your opponent's).": ctx => {
    pocketDiscardRandomEnergyInPlay(ctx.G, 2);
  },
  "Flip a coin. If heads, your opponent reveals a random card from their hand and shuffles it into their deck.": ctx => {
    if (!pocketFlipCoin(ctx) || !ctx.oppSide.hand.length) return;
    const i = Math.floor(Math.random() * ctx.oppSide.hand.length);
    const [card] = ctx.oppSide.hand.splice(i, 1);
    ctx.oppSide.deck = pocketShuffle([...ctx.oppSide.deck, card]);
  },
  "This attack does 100 damage to 1 of your opponent's Pokémon that have damage on them.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(p => p && p.curHp < p.hp);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 100 };
  },
  "This attack does 30 more damage for each Energy in your opponent's Active Pokémon's Retreat Cost.": ctx => {
    ctx.rawDamage += 30 * (ctx.defender?.retreat || 0);
  },
  "Discard Fire{R} Energy from this Pokémon. Your opponent's Active Pokémon is now Burned.": ctx => {
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fire', 1);
    if (ctx.defender) ctx.defender.burned = true;
  },
  "If the amount of Energy attached to both Active Pokémon is 5 or more, this attack does 60 more damage.": ctx => {
    if (ctx.attacker.energy.length + (ctx.defender?.energy.length || 0) >= 5) ctx.rawDamage += 60;
  },
  "This attack also does 30 damage to each of your opponent's Benched Pokémon that has damage on it.": ctx => {
    for (const p of ctx.oppSide.bench) { if (p.curHp < p.hp && !pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 30); }
  },
  "Take 3 {P} Energy from your Energy Zone and attach it to your {P} Pokémon in any way you like.": ctx => {
    const targets = [ctx.side.active, ...ctx.side.bench].filter(p => p && (p.types || []).includes('Psychic'));
    if (targets.length) {
      ctx.needsChoice = { kind: 'energy_distribute', energyQueue: ['Psychic', 'Psychic', 'Psychic'], eligibleUids: targets.map(p => p.uid), includeActive: true };
    }
    ctx.rawDamage = 0;
  },
  // 指名招式封鎖（generic機制，見pocket_attack handler的moveLockUntilTurn/moveLockName檢查）
  "During your next turn, this Pokémon can't use Frenzy Plant.": ctx => { ctx.attacker.moveLockUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveLockName = 'Frenzy Plant'; },
  "During your next turn, this Pokémon can't use Big Beat.": ctx => { ctx.attacker.moveLockUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveLockName = 'Big Beat'; },
  "During your next turn, this Pokémon can't use Sacred Sword.": ctx => { ctx.attacker.moveLockUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveLockName = 'Sacred Sword'; },
  "During your next turn, this Pokémon can't use Gigaton Hammer.": ctx => { ctx.attacker.moveLockUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveLockName = 'Gigaton Hammer'; },
  // 指名招式下回合加成（generic機制，見pocket_attack handler的moveBuffUntilTurn/moveBuffName/moveBuffAmount）
  "During your next turn, this Pokémon's Insatiable Striking attack does +40 damage.": ctx => {
    ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.moveBuffName = 'Insatiable Striking'; ctx.attacker.moveBuffAmount = 40;
  },

  /* ── 2026-08-07第三批新增：依出現頻率繼續補高頻效果，同時修正了另一個彎引號變體
     （A1-151/A1-239 Cubone跟B2a那批不同，是原始資料裡真實存在的另一種變體，不是bug） ── */
  "During your opponent’s next turn, attacks used by the Defending Pokémon do −20 damage.": ctx => {
    ctx.defender.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; ctx.defender.dmgDebuffAmount = 20;
  },
  "Discard 3 {W} Energy from this Pokémon. This attack also does 20 damage to each of your opponent's Benched Pokémon.": ctx => {
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Water', 3);
    for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 20); }
  },
  "Flip 2 coins. This attack does 90 damage for each heads. Your opponent's Active Pokémon is now Confused.": ctx => {
    ctx.rawDamage = pocketFlipCoins(2, ctx) * 90;
    if (ctx.defender) ctx.defender.status = 'confused';
  },
  // 2026-08-07修正：這條文字「1 of your opponent's Pokémon」沒寫at random，改成pick_target
  // 讓玩家自選（跟修皮丘那批同一個原則），target的pool是oppAll(對手主戰+板凳都能選)
  "This attack does 140 damage to 1 of your opponent's Pokémon. During your next turn, this Pokémon can't attack.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 140 };
    ctx.attacker.cantAttackUntilTurn = ctx.G.turnNumber + 1;
  },
  "Discard all Water Energy from this Pokémon. This attack does 130 damage to 1 of your opponent's Pokémon.": ctx => {
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Water', ctx.attacker.energy.filter(e => e === 'Water').length);
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 130 };
  },
  "If you have 4 or more Lightning Energy in play, this attack does 70 more damage.": ctx => {
    const total = [ctx.side.active, ...ctx.side.bench].filter(Boolean).reduce((n, p) => n + p.energy.filter(e => e === 'Lightning').length, 0);
    if (total >= 4) ctx.rawDamage += 70;
  },
  "Flip 2 coins. This attack does 100 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(2, ctx) * 100; },
  "This attack does 30 damage for each of your Benched Pokémon.": ctx => { ctx.rawDamage = 30 * ctx.side.bench.length; },
  "Discard 2 {R} Energy from this Pokémon. This attack does 80 damage to 1 of your opponent's Pokémon.": ctx => {
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Fire', 2);
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 80 };
  },
  "If this Pokémon has at least 2 extra {L} Energy attached, this attack does 80 more damage.": ctx => {
    const have = ctx.attacker.energy.filter(e => e === 'Lightning').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Lightning').length;
    if (have - need >= 2) ctx.rawDamage += 80;
  },
  "If your opponent's Active Pokémon is Poisoned, this attack does 40 more damage.": ctx => { if (ctx.defender?.poisoned) ctx.rawDamage += 40; },
  "Heal 20 damage from each of your Pokémon.": ctx => {
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) p.curHp = Math.min(p.hp, p.curHp + 20);
  },
  // 「Choose 2」語法要選2隻不同的板凳，各附加1點水能量——新的pick_target_multi機制
  "Choose 2 of your Benched Pokémon. For each of those Pokémon, take a {W} Energy from your Energy Zone and attach it to that Pokémon.": ctx => {
    if (ctx.side.bench.length) {
      ctx.needsChoice = { kind: 'pick_target_multi', eligibleUids: ctx.side.bench.map(p => p.uid), energyType: 'Water', remaining: Math.min(2, ctx.side.bench.length) };
    }
  },
  "Discard the top 3 cards of your deck.": ctx => { ctx.side.discard.push(...ctx.side.deck.splice(0, 3)); },
  // 究極奈克洛茲瑪ex「噴洩搖滾」（Fan Made，Promo-A P-A-039，2026-08-17新增）：雙方各自棄掉
  // 牌庫最上面5張——splice(0,5)在牌庫不足5張時自然只拿現有的，不用額外判斷邊界
  "Discard the top 5 cards of each player's deck.": ctx => {
    ctx.side.discard.push(...ctx.side.deck.splice(0, 5));
    ctx.oppSide.discard.push(...ctx.oppSide.deck.splice(0, 5));
  },
  "Flip 2 coins. This attack does 20 more damage for each heads.": ctx => { ctx.rawDamage += pocketFlipCoins(2, ctx) * 20; },
  "This attack does 10 damage to each of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    if (ctx.defender && !pocketSafeguardImmune(ctx.defender, ctx.attacker)) ctx.defender.curHp = Math.max(0, ctx.defender.curHp - 10);
    for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 10); }
  },
  "Flip a coin for each Pokémon you have in play. This attack does 20 damage for each heads.": ctx => {
    const n = 1 + ctx.side.bench.length;
    ctx.rawDamage = pocketFlipCoins(n, ctx) * 20;
  },
  "Flip 2 coins. This attack does 40 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(2, ctx) * 40; },
  "Flip 4 coins. This attack does 20 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(4, ctx) * 20; },
  "Flip a coin for each {M} Energy attached to this Pokémon. This attack does 50 damage for each heads.": ctx => {
    ctx.rawDamage = pocketFlipCoins(ctx.attacker.energy.filter(e => e === 'Metal').length, ctx) * 50;
  },
  "Flip 3 coins. This attack does 50 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(3, ctx) * 50; },
  "Flip a coin. If tails, this Pokémon also does 20 damage to itself.": ctx => { if (!pocketFlipCoin(ctx)) ctx.selfDamage = (ctx.selfDamage || 0) + 20; },
  "Flip 2 coins. This attack does 70 damage for each heads. If at least 1 of them is heads, your opponent's Active Pokémon is now Burned.": ctx => {
    const heads = pocketFlipCoins(2, ctx);
    ctx.rawDamage = heads * 70;
    if (heads >= 1 && ctx.defender) ctx.defender.burned = true;
  },
  "Take a {W} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { ctx.attacker.energy.push('Water'); },
  // type-filtered bench_switch：跟既有「Switch this Pokémon with 1 of your Benched Pokémon」
  // 同一個kind，多帶一個eligibleUids篩選限定電系板凳
  "Switch this Pokémon with 1 of your Benched {L} Pokémon.": ctx => {
    const targets = ctx.side.bench.filter(p => (p.types || []).includes('Lightning'));
    if (targets.length) ctx.needsChoice = { kind: 'bench_switch', eligibleUids: targets.map(p => p.uid) };
    ctx.rawDamage = 0;
  },
  // 傷害依「被選中的目標」自己身上的能量數決定，選目標的當下還不知道數值，用damagePerEnergy
  // 這個新action，實際傷害在pocket_attack_choice handler解析目標之後才計算
  "This attack does 20 damage to 1 of your opponent's Pokémon for each Energy attached to that Pokémon.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damagePerEnergy', perEnergy: 20 };
  },
  "Put a random card that evolves from Rockruff from your deck into your hand.": ctx => {
    const idxs = ctx.side.deck.map((c, i) => c.evolveFrom === 'Rockruff' ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); }
  },
  "This Pokémon also does 40 damage to itself.": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 40; },
  "Flip a coin until you get tails. This attack does 70 damage for each heads.": ctx => {
    let heads = 0;
    while (pocketFlipCoin(ctx)) heads++;
    ctx.rawDamage = heads * 70;
  },
  "If your opponent's Active Pokémon has an Ability, this attack does 40 more damage.": ctx => { if (ctx.defender?.abilities?.length) ctx.rawDamage += 40; },
  "If any of your Benched Pokémon have damage on them, this attack does 50 more damage.": ctx => {
    if (ctx.side.bench.some(p => p.curHp < p.hp)) ctx.rawDamage += 50;
  },

  // ── 招式效果第四批（2026-08-07，配合Tool系統一起擴充）──
  // Tool相關：Pokémon Tool系統上線後這類效果才有意義，直接查attacker/defender.tool
  "If this Pokémon has a Pokémon Tool attached, this attack does 50 more damage.": ctx => { if (ctx.attacker.tool) ctx.rawDamage += 50; },
  "If this Pokémon has a Pokémon Tool attached, this attack does 40 more damage.": ctx => { if (ctx.attacker.tool) ctx.rawDamage += 40; },
  "If this Pokémon has a Pokémon Tool attached, this attack does 30 more damage.": ctx => { if (ctx.attacker.tool) ctx.rawDamage += 30; },
  "If your opponent's Active Pokémon has a Pokémon Tool attached, this attack does 30 more damage.": ctx => { if (ctx.defender?.tool) ctx.rawDamage += 30; },
  // Before doing damage的字面意思是「先解除裝備，這次攻擊的傷害計算才生效」，實務上因為
  // ctx.rawDamage是攻擊當下才算，這裡先移除tool並不影響本次固定傷害的計算順序
  "Before doing damage, discard all Pokémon Tools from your opponent's Active Pokémon.": ctx => {
    const p = ctx.defender;
    if (!p?.tool) return;
    pocketDiscardTool(p); // KO判定交給pocket_attack handler本來就有的攻擊後curHp<=0檢查，這裡不用自己判斷
  },
  "Discard a random Pokémon Tool card from your opponent's hand.": ctx => {
    const idxs = ctx.oppSide.hand.map((c, i) => (c.category === 'Trainer' && c.trainerType === 'Tool') ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; const [card] = ctx.oppSide.hand.splice(i, 1); ctx.oppSide.discard.push(card); }
  },

  // 異常狀態組合：卡面沒寫"at random"的都是必定觸發（跟其他單一狀態效果一致，不用骰）
  // 2026-08-13修正：這兩張都是雙重狀態組合（中毒+另一種），原本只設了poisoned一半，另一半
  // （睡眠／麻痺）被吃掉——中毒獨立出來後可以跟status欄位的睡眠/麻痺同時成立，兩個都要設
  "Your opponent's Active Pokémon is now Poisoned and Asleep.": ctx => { if (ctx.defender) { ctx.defender.poisoned = true; ctx.defender.status = 'asleep'; } },
  "Flip a coin. If heads, your opponent's Active Pokémon is now Poisoned and Paralyzed.": ctx => { if (pocketFlipCoin(ctx) && ctx.defender) { ctx.defender.poisoned = true; ctx.defender.status = 'paralyzed'; } },
  "Your opponent's Active Pokémon is now Poisoned. During your opponent's next turn, that Pokémon can't retreat.": ctx => {
    if (!ctx.defender) return;
    ctx.defender.poisoned = true;
    ctx.defender.cantRetreatUntilTurn = ctx.G.turnNumber + 1;
  },
  "Flip 4 coins. This attack does 40 damage for each heads. If at least 2 of them are heads, your opponent's Active Pokémon is now Poisoned.": ctx => {
    const heads = pocketFlipCoins(4, ctx);
    ctx.rawDamage = heads * 40;
    if (heads >= 2 && ctx.defender) ctx.defender.poisoned = true;
  },

  // 自身狀態/場面條件觸發的加傷——都是查ctx上已有的資料，不需要新的追蹤欄位
  "If you have exactly 1, 3, or 5 cards in your hand, this attack does 60 more damage.": ctx => { if ([1, 3, 5].includes(ctx.side.hand.length)) ctx.rawDamage += 60; },
  "If your opponent's Active Pokémon is a Basic Pokémon, this attack does 70 more damage.": ctx => { if (ctx.defender?.stage === 'Basic') ctx.rawDamage += 70; },
  "If your opponent has gotten exactly 1 points, this attack does 40 more damage.": ctx => { if (ctx.oppSide.points === 1) ctx.rawDamage += 40; },
  "If your opponent's Active Pokémon has damage on it, this attack does 50 more damage.": ctx => { if (ctx.defender && ctx.defender.curHp < ctx.defender.hp) ctx.rawDamage += 50; },
  "If you have fewer Pokémon in play than your opponent, this attack does 80 more damage.": ctx => {
    const mine = [ctx.side.active, ...ctx.side.bench].filter(Boolean).length;
    const theirs = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean).length;
    if (mine < theirs) ctx.rawDamage += 80;
  },
  "If you played a Supporter card from your hand during this turn, this attack does 50 more damage.": ctx => { if (ctx.side.supporterUsedThisTurn) ctx.rawDamage += 50; },
  "This attack's damage is reduced by the amount of damage this Pokémon has on it.": ctx => { ctx.rawDamage = Math.max(0, ctx.rawDamage - (ctx.attacker.hp - ctx.attacker.curHp)); },
  "If your opponent’s Active Pokémon is a Pokémon {ex}, this attack does 80 more damage.": ctx => { if (ctx.defender?.ex) ctx.rawDamage += 80; },
  "If your opponent's Active Pokémon is a Pokémon {ex}, this attack does 30 more damage.": ctx => { if (ctx.defender?.ex) ctx.rawDamage += 30; },
  "If your opponent's Active Pokémon is a {F} Pokémon, this attack does 30 more damage.": ctx => { if ((ctx.defender?.types || []).includes('Fighting')) ctx.rawDamage += 30; },
  "This attack does 40 more damage for each of your opponent's Pokémon in play that has an Ability.": ctx => {
    const n = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(p => p?.abilities?.length).length;
    ctx.rawDamage += n * 40;
  },
  "If this Pokémon has damage on it, this attack does 40 more damage.": ctx => { if (ctx.attacker.curHp < ctx.attacker.hp) ctx.rawDamage += 40; },
  // Revenge系（Marshadow等）：需要新增side.lostToAttackLastOppTurn旗標，見pocketResolveActiveKO
  // 的設定點跟pocketRunCheckup的清除點——「你上一個對手回合有寶可夢被攻擊擊倒」只在緊接著的
  // 這一整個回合有效，回合結束就清掉，不會一直殘留
  "If any of your Pokémon were Knocked Out by damage from an attack during your opponent's last turn, this attack does 60 more damage.": ctx => {
    if (ctx.side.lostToAttackLastOppTurn) ctx.rawDamage += 60;
  },

  // 擲硬幣變體
  "Flip 3 coins. This attack does 30 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(3, ctx) * 30; },
  "Flip a coin until you get tails. This attack does 60 damage for each heads.": ctx => {
    let heads = 0;
    while (pocketFlipCoin(ctx)) heads++;
    ctx.rawDamage = heads * 60;
  },
  "Flip 2 coins. If both of them are heads, this attack does 80 more damage.": ctx => { if (pocketFlipCoins(2, ctx) === 2) ctx.rawDamage += 80; },
  "Flip 2 coins. If both of them are heads, this attack does 70 more damage.": ctx => { if (pocketFlipCoins(2, ctx) === 2) ctx.rawDamage += 70; },
  "Flip 3 coins. This attack does 50 more damage for each heads.": ctx => { ctx.rawDamage += pocketFlipCoins(3, ctx) * 50; },
  "Flip a coin until you get tails. This attack does 30 more damage for each heads.": ctx => {
    let heads = 0;
    while (pocketFlipCoin(ctx)) heads++;
    ctx.rawDamage += heads * 30;
  },
  "Flip a coin for each Pokémon you have in play. This attack does 40 damage for each heads.": ctx => {
    const n = [ctx.side.active, ...ctx.side.bench].filter(Boolean).length;
    ctx.rawDamage = pocketFlipCoins(n, ctx) * 40;
  },
  "Flip a coin. If tails, this Pokémon also does 50 damage to itself.": ctx => { if (!pocketFlipCoin(ctx)) ctx.selfDamage = (ctx.selfDamage || 0) + 50; },
  "Flip a coin. If heads, this attack does 60 more damage. If tails, this Pokémon also does 20 damage to itself.": ctx => {
    if (pocketFlipCoin(ctx)) ctx.rawDamage += 60; else ctx.selfDamage = (ctx.selfDamage || 0) + 20;
  },
  "Flip 3 coins. For each heads, discard a random Energy from your opponent's Active Pokémon.": ctx => {
    const heads = pocketFlipCoins(3, ctx);
    for (let i = 0; i < heads; i++) {
      if (ctx.defender?.energy.length) { const [t] = ctx.defender.energy.splice(Math.floor(Math.random() * ctx.defender.energy.length), 1); ctx.oppSide.discardEnergy.push(t); }
    }
  },
  "Flip a coin. If heads, look at a random card from your opponent's hand and shuffle it into their deck.": ctx => {
    if (!pocketFlipCoin(ctx) || !ctx.oppSide.hand.length) return;
    const i = Math.floor(Math.random() * ctx.oppSide.hand.length);
    const [card] = ctx.oppSide.hand.splice(i, 1);
    ctx.oppSide.deck.push(card);
    ctx.oppSide.deck = pocketShuffle(ctx.oppSide.deck);
  },

  // 從能量區拿指定屬性能量附加——跟Tool系統的Bouncy Body同一套「這回合能量區剛好是那個
  // 屬性才有得拿」判斷，不是憑空生出能量。附加到「這隻寶可夢」自己身上的版本
  "Take a {G} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { if (ctx.side.pendingEnergy === 'Grass') { ctx.attacker.energy.push('Grass'); ctx.side.pendingEnergy = null; } },
  "Take a {R} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { if (ctx.side.pendingEnergy === 'Fire') { ctx.attacker.energy.push('Fire'); ctx.side.pendingEnergy = null; } },
  "Take 1 {M} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { if (ctx.side.pendingEnergy === 'Metal') { ctx.attacker.energy.push('Metal'); ctx.side.pendingEnergy = null; } },
  "Take a {G} Energy from your Energy Zone and attach it to 1 of your Benched {G} Pokémon.": ctx => {
    if (ctx.side.pendingEnergy !== 'Grass') return;
    const targets = ctx.side.bench.filter(p => (p.types || []).includes('Grass'));
    if (targets.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: targets.map(p => p.uid), action: 'attachEnergy', energyType: 'Grass', count: 1 };
  },
  "Take a Metal Energy from your Energy Zone and attach it to 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.pendingEnergy !== 'Metal' || !ctx.side.bench.length) return;
    ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'attachEnergy', energyType: 'Metal', count: 1 };
  },

  // 自己板凳的治療/濺傷——重用既有的pick_target機制(action:'heal'是這批新增的)
  "Heal 50 damage from 1 of your Benched Pokémon.": ctx => {
    const targets = ctx.side.bench.filter(p => p.curHp < p.hp);
    if (targets.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: targets.map(p => p.uid), action: 'heal', amount: 50 };
  },
  "This attack also does 20 damage to 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'damage', amount: 20 };
  },

  // 棄牌/其他
  "Discard 2 cards from your hand. If you can't discard 2 cards, this attack does nothing.": ctx => {
    if (ctx.side.hand.length < 2) { ctx.rawDamage = 0; return; }
    for (let i = 0; i < 2; i++) {
      const idx = Math.floor(Math.random() * ctx.side.hand.length);
      const [card] = ctx.side.hand.splice(idx, 1);
      ctx.side.discard.push(card);
    }
  },
  "Put a random card from your deck that evolves from this Pokémon onto this Pokémon to evolve it.": ctx => {
    const candidates = ctx.side.deck.map((c, i) => ({ c, i })).filter(({ c }) => c.category === 'Pokemon' && c.evolveFrom === ctx.attacker.name);
    if (!candidates.length) return;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    ctx.side.deck.splice(pick.i, 1);
    const preservedDamage = (ctx.attacker.hp || 0) - (ctx.attacker.curHp ?? ctx.attacker.hp ?? 0);
    const preservedEnergy = ctx.attacker.energy;
    const preservedUid = ctx.attacker.uid;
    Object.assign(ctx.attacker, structuredClone(POCKET_CARDS_BY_ID[pick.c.id]));
    ctx.attacker.uid = preservedUid; ctx.attacker.energy = preservedEnergy;
    ctx.attacker.status = null; ctx.attacker.poisoned = false; ctx.attacker.burned = false; // 2026-08-16應使用者要求：進化時異常狀態要清掉
    ctx.attacker.curHp = Math.max(1, (ctx.attacker.hp || 0) - preservedDamage);
    ctx.attacker.boardTurn = ctx.G.turnNumber;
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    ctx.attacker._realAbilities = undefined; // 2026-08-08修正：進化後身分變了，清掉舊快取讓特性正確重抓
    pocketApplyDoubleType(ctx.attacker);
  },

  // 招式借用（2026-08-07新增pick_move機制，見pocket_attack_choice handler的說明）：兩種卡面
  // 版本文字有直引號/彎引號差異，是TCGdex原始資料本身的印刷版本差異，兩個key都要留著分別
  // 對應不同的實際卡片（跟先前Cubone那次彎引號的教訓一樣，不是bug）
  "Choose 1 of your opponent's Active Pokémon's attacks and use it as this attack.": ctx => {
    ctx.rawDamage = 0; // 實際傷害延遲到玩家選完招式才套用，這裡先歸零避免mainDamage誤用0-effect前的殘留值
    if (!ctx.defender?.attacks?.length) return;
    ctx.needsChoice = { kind: 'pick_move' };
  },
  "Choose 1 of your opponent’s Pokémon’s attacks and use it as this attack. If this Pokémon doesn’t have the necessary Energy to use that attack, this attack does nothing.": ctx => {
    ctx.rawDamage = 0;
    if (!ctx.defender?.attacks?.length) return;
    ctx.needsChoice = { kind: 'pick_move', checkEnergy: true };
  },

  // 對手公開手牌選擇（2026-08-07新增，重用pick_target的pool='oppHand'）——ctx.peekHand讓client
  // 顯示對手手牌內容(既有機制)，needsChoice暫停等玩家從中點選
  "Your opponent reveals their hand. Choose a Supporter card you find there and discard it.": ctx => {
    ctx.peekOpponentHand = true; // 這個handler(pocket_attack)是用peekOpponentHand欄位名稱，跟pocket_play_item/supporter用的peekHand不同，別搞混
    const eligible = ctx.oppSide.hand.filter(c => c.category === 'Trainer' && c.trainerType === 'Supporter');
    if (eligible.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppHand', eligibleUids: eligible.map(c => c.uid), action: 'discard' };
  },
  "Your opponent reveals their hand. Choose a card you find there and shuffle it into your opponent's deck.": ctx => {
    ctx.peekOpponentHand = true;
    if (ctx.oppSide.hand.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppHand', eligibleUids: ctx.oppSide.hand.map(c => c.uid), action: 'shuffleIntoDeck' };
  },

  // ── 招式效果第五批（2026-08-07再接續）──
  "This attack does 40 more damage for each of your Benched Wishiwashi and Wishiwashi ex.": ctx => {
    const n = ctx.side.bench.filter(p => p.name === 'Wishiwashi' || p.name === 'Wishiwashi ex').length;
    ctx.rawDamage += n * 40;
  },
  "This attack does 50 more damage for each of your Benched Nidoking.": ctx => {
    const n = ctx.side.bench.filter(p => p.name === 'Nidoking').length;
    ctx.rawDamage += n * 50;
  },
  // 「只能在特定條件下使用這招」的招式級別限制——這個引擎沒有「事前擋下不給選」的機制，
  // 簡化成「條件不符就沒效果」（能量/回合仍然消耗，跟真實規則「根本選不了這招」有落差，
  // 但只有這1張卡需要這個限制，做完整的招式可用性前置檢查投入產出比不划算）
  "You can use this attack only if you have Uxie and Azelf on your Bench. Discard all Energy from this Pokémon.": ctx => {
    const names = ctx.side.bench.map(p => p.name);
    if (!names.includes('Uxie') || !names.includes('Azelf')) { ctx.rawDamage = 0; return; }
    ctx.side.discardEnergy.push(...ctx.attacker.energy);
    ctx.attacker.energy = [];
  },
  "This attack does 20 more damage for each {G} Energy attached to this Pokémon.": ctx => {
    ctx.rawDamage += ctx.attacker.energy.filter(e => e === 'Grass').length * 20;
  },
  "This attack does 20 damage for each Energy attached to all of your opponent's Pokémon.": ctx => {
    const n = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean).reduce((sum, p) => sum + p.energy.length, 0);
    ctx.rawDamage = n * 20;
  },
  "This attack does 30 more damage for each Evolution Pokémon on your Bench.": ctx => {
    ctx.rawDamage += ctx.side.bench.filter(p => p.stage && p.stage !== 'Basic').length * 30;
  },
  // 濺傷自己整個板凳(固定量，非玩家自選目標)——主流程本來就會在effectFn跑完後對side/oppSide
  // 雙方各呼叫一次pocketResolveBenchKOs，這裡直接扣血、KO判定不用自己處理
  "This attack also does 10 damage to each of your Benched Pokémon.": ctx => {
    ctx.side.bench.forEach(p => { p.curHp = Math.max(0, p.curHp - 10); });
  },
  "If the Defending Pokémon is a Basic Pokémon, it can't attack during your opponent's next turn.": ctx => {
    if (ctx.defender?.stage === 'Basic') ctx.defender.cantAttackUntilTurn = ctx.G.turnNumber + 1;
  },
  "Flip 3 coins. This attack does 60 damage for each heads. This Pokémon is now Confused.": ctx => {
    ctx.rawDamage = pocketFlipCoins(3, ctx) * 60;
    ctx.attacker.status = 'confused';
  },
  "If this Pokémon has no damage on it, this attack does 40 more damage.": ctx => { if (ctx.attacker.curHp === ctx.attacker.hp) ctx.rawDamage += 40; },
  // Math.min而不是直接賦值10——如果defender本來就低於10血，不該被這個效果「回血」到10
  "Flip a coin. If heads, your opponent's Active Pokémon's remaining HP is now 10.": ctx => {
    if (pocketFlipCoin(ctx) && ctx.defender) ctx.defender.curHp = Math.min(ctx.defender.curHp, 10);
  },
  "Change the type of a random Energy attached to your opponent's Active Pokémon to 1 of the following at random: {G}, {R}, {W}, {L}, {P}, {F}, {D}, or {M}.": ctx => {
    if (!ctx.defender?.energy.length) return;
    const idx = Math.floor(Math.random() * ctx.defender.energy.length);
    const types = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];
    ctx.defender.energy[idx] = types[Math.floor(Math.random() * types.length)];
  },
  "This attack does damage to your opponent's Active Pokémon equal to the damage this Pokémon has on it.": ctx => {
    ctx.rawDamage = ctx.attacker.hp - ctx.attacker.curHp;
  },
  "If Quick-Grow Extract is in your discard pile, this attack does 30 more damage.": ctx => {
    if (ctx.side.discard.some(c => c.name === 'Quick-Grow Extract')) ctx.rawDamage += 30;
  },
  // 固定傷害給對手板凳單體——卡面沒寫"at random"，玩家自選，重用既有pick_target(pool:'oppAll')
  // 機制，eligibleUids只給板凳的uid（不含主戰）就能自然限縮選擇範圍，不用新增pool類型
  "This attack does 70 damage to 1 of your opponent's Benched Pokémon.": ctx => {
    ctx.rawDamage = 0;
    if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 70 };
  },
  // 隨機多次攻擊(次數=自身鋼能量數)，跟先前Dragonite流星群同一種寫法——這條key結尾原始資料
  // 本身有一個尾隨空格，逐字比對必須保留
  "1 of your opponent's Pokémon is chosen at random for each Metal Energy attached to this Pokémon. For each time a Pokémon was chosen, do 40 damage to it. ": ctx => {
    ctx.rawDamage = 0;
    const n = ctx.attacker.energy.filter(e => e === 'Metal').length;
    const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
    for (let i = 0; i < n && pool.length; i++) {
      const t = pool[Math.floor(Math.random() * pool.length)];
      t.curHp = Math.max(0, t.curHp - 40);
    }
  },

  /* ── 2026-08-08新增：B2b~B4系列招式效果第一批 ── */
  "If your opponent's Active Pokémon is Confused, this attack does 40 more damage.": ctx => { if (ctx.defender?.status === 'confused') ctx.rawDamage += 40; },
  "If this Pokémon's remaining HP is 110 or less, this attack does 80 more damage.": ctx => { if (ctx.attacker.curHp <= 110) ctx.rawDamage += 80; },
  "If Electivire is on your Bench, this attack also does 20 damage to each of your opponent's Benched Pokémon.": ctx => {
    if (pocketFindOwnByName(ctx.side, ['Electivire'])) for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 20); }
  },
  "Flip 3 coins. This attack also does 20 damage for each heads to each of your opponent's Benched Pokémon.": ctx => {
    const heads = [1, 2, 3].filter(() => pocketFlipCoin(ctx)).length;
    if (heads) for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - heads * 20); }
  },
  "If any of your Pokémon were Knocked Out by damage from an attack during your opponent's last turn, your opponent's Active Pokémon is now Paralyzed.": ctx => {
    if (ctx.side.lostToAttackLastOppTurn && ctx.defender) ctx.defender.status = 'paralyzed';
  },
  "If your opponent's Active Pokémon has more remaining HP than this Pokémon, this attack does 60 more damage.": ctx => {
    if (ctx.defender && ctx.defender.curHp > ctx.attacker.curHp) ctx.rawDamage += 60;
  },
  "Take a {W} Energy from your Energy Zone and attach it to 1 of your Benched {W} Pokémon.": ctx => {
    const targets = ctx.side.bench.filter(p => (p.types || []).includes('Water'));
    if (targets.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: targets.map(p => p.uid), action: 'attachEnergy', energyType: 'Water', count: 1 };
  },
  "If Magmortar is on your Bench, this attack does 70 more damage.": ctx => { if (pocketFindOwnByName(ctx.side, ['Magmortar'])) ctx.rawDamage += 70; },
  "This attack does 30 more damage for each point you have gotten.": ctx => { ctx.rawDamage += (ctx.side.points || 0) * 30; },
  // 簡化：從對手手牌+牌庫的寶可夢招式池隨機挑1招，只重現傷害數字（不重新執行該招式的文字效果）——
  // 真的要重現任意招式的完整效果需要遞迴呼叫ATTACK_EFFECTS本身且處理needsChoice等狀態機，
  // 風險/複雜度遠超過這1張卡的效益，跟Time Recall/Victory Star同一類investment/return考量
  "1 attack from among the Pokémon in your opponent's hand and deck is chosen at random, and you use the chosen attack as this attack.": ctx => {
    const pool = [...ctx.oppSide.hand, ...ctx.oppSide.deck].filter(c => c.category === 'Pokemon' && c.attacks?.length).flatMap(c => c.attacks);
    if (!pool.length) { ctx.rawDamage = 0; return; }
    const atk = pool[Math.floor(Math.random() * pool.length)];
    ctx.rawDamage = parseInt(String(atk.damage || '0').replace(/\D+/g, ''), 10) || 0;
  },
  "If your opponent has exactly 2, 4, or 6 cards in their hand, this attack does 40 more damage.": ctx => { if ([2, 4, 6].includes(ctx.oppSide.hand.length)) ctx.rawDamage += 40; },
  "Discard 2 random Energy from among the Energy attached to all of your Pokémon.": ctx => { pocketDiscardRandomEnergyOwnSide(ctx.side, 2); },
  "During your opponent's next turn, they can't play any Trainer cards from their hand.": ctx => {
    ctx.oppSide.itemLockedUntilTurn = ctx.G.turnNumber + 1;
    ctx.oppSide.supporterLockedUntilTurn = ctx.G.turnNumber + 1;
  },
  "Move 2 {D} Energy from this Pokémon to 1 of your Benched Pokémon.": ctx => {
    if (ctx.attacker.energy.filter(e => e === 'Darkness').length >= 2 && ctx.side.bench.length) {
      ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'moveAllEnergyFromAttacker', energyFilter: 'Darkness', count: 2 };
    }
  },
  "This Pokémon also does 100 damage to itself and 50 damage to all Benched Pokémon (both yours and your opponent's).": ctx => {
    ctx.attacker.curHp = Math.max(0, ctx.attacker.curHp - 100);
    // 自己板凳不受神秘守護保護（Safeguard只擋「對手ex的攻擊」，自己板凳的持有者跟attacker同隊，
    // attacker不是牠的「對手」），只有oppSide.bench要檢查
    for (const p of ctx.side.bench) p.curHp = Math.max(0, p.curHp - 50);
    for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 50); }
  },
  "Take a {W} and a {L} Energy from your Energy Zone and attach them to this Pokémon.": ctx => {
    ctx.attacker.energy.push('Water');
    ctx.attacker.energy.push('Lightning');
  },
  "Discard a {W} and a {L} Energy from this Pokémon.": ctx => { pocketDiscardEnergy(ctx.side, ctx.attacker, 'Water', 1); pocketDiscardEnergy(ctx.side, ctx.attacker, 'Lightning', 1); },
  "This attack does 20 more damage for each Benched Pokémon (both yours and your opponent's).": ctx => { ctx.rawDamage += 20 * (ctx.side.bench.length + ctx.oppSide.bench.length); },
  "If you have any Stage 2 Pokémon on your Bench, this attack does 50 more damage.": ctx => { if (ctx.side.bench.some(p => p.stage === 'Stage2')) ctx.rawDamage += 50; },
  "Discard a {G} Energy from this Pokémon. Your opponent's Active Pokémon is now Poisoned.": ctx => { pocketDiscardEnergy(ctx.side, ctx.attacker, 'Grass', 1); if (ctx.defender) ctx.defender.poisoned = true; },
  "Discard a {R} Energy from your opponent's Active Pokémon.": ctx => { if (ctx.defender) pocketDiscardEnergy(ctx.oppSide, ctx.defender, 'Fire', 1); },
  "If your opponent's Active Pokémon is Asleep, this attack does 60 more damage.": ctx => { if (ctx.defender?.status === 'asleep') ctx.rawDamage += 60; },
  // 「失去全部特性，直到離開主戰位置」——用_realAbilities同一套快取機制強制清空，離開主戰時
  // （撤退/board_switch）解除，見那兩處呼叫pocketClearAbilityLock的地方
  "The Defending Pokémon loses all Abilities. This effect lasts until the Defending Pokémon leaves the Active Spot.": ctx => {
    if (!ctx.defender) return;
    if (ctx.defender._realAbilities === undefined) ctx.defender._realAbilities = ctx.defender.abilities;
    ctx.defender.abilities = [];
    ctx.defender._abilitiesLockedOff = true;
  },
  "If Durant is on your Bench, this attack does 30 more damage.": ctx => { if (pocketFindOwnByName(ctx.side, ['Durant'])) ctx.rawDamage += 30; },
  "Heal 30 damage from 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'heal', amount: 30 };
  },
  "Flip 3 coins. For each heads, discard a {R} Energy from this Pokémon. This attack does 30 more damage for each {R} Energy you discarded in this way.": ctx => {
    let discarded = 0;
    for (let i = 0; i < 3; i++) {
      if (!pocketFlipCoin(ctx)) continue;
      const idx = ctx.attacker.energy.indexOf('Fire');
      if (idx < 0) continue;
      ctx.attacker.energy.splice(idx, 1);
      ctx.side.discardEnergy.push('Fire');
      discarded++;
    }
    ctx.rawDamage += discarded * 30;
  },
  "1 of your opponent's Pokémon is chosen at random. Do 160 damage to it.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) { const t = pool[Math.floor(Math.random() * pool.length)]; t.curHp = Math.max(0, t.curHp - 160); }
  },
  "If a Stadium is in play, your opponent's Active Pokémon is now Burned.": ctx => { if (ctx.G.activeStadium && ctx.defender) ctx.defender.burned = true; },
  "Flip a coin. If heads, take 2 {R} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { if (pocketFlipCoin(ctx)) ctx.attacker.energy.push('Fire', 'Fire'); },
  "Flip a coin for each {R} Energy attached to this Pokémon. This attack does 30 more damage for each heads.": ctx => {
    const n = ctx.attacker.energy.filter(e => e === 'Fire').length;
    let heads = 0;
    for (let i = 0; i < n; i++) if (pocketFlipCoin(ctx)) heads++;
    ctx.rawDamage += heads * 30;
  },
  "If this Pokémon evolved from Poliwhirl during this turn, this attack does 50 more damage.": ctx => { if (ctx.attacker.evolveFrom === 'Poliwhirl' && ctx.attacker.boardTurn === ctx.G.turnNumber) ctx.rawDamage += 50; },
  "If this Pokémon has any {F} Energy attached, this attack does 60 more damage.": ctx => { if (ctx.attacker.energy.includes('Fighting')) ctx.rawDamage += 60; },
  "If a Stadium is in play, heal 20 damage from this Pokémon.": ctx => { if (ctx.G.activeStadium) ctx.attacker.curHp = Math.min(ctx.attacker.hp, ctx.attacker.curHp + 20); },
  "If a Stadium is in play, your opponent's Active Pokémon is now Asleep.": ctx => { if (ctx.G.activeStadium && ctx.defender) ctx.defender.status = 'asleep'; },
  "Move 2 random Energy from this Pokémon to 1 of your Benched Pokémon.": ctx => {
    if (ctx.attacker.energy.length && ctx.side.bench.length) {
      ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'moveAllEnergyFromAttacker', count: Math.min(2, ctx.attacker.energy.length) };
    }
  },
  "Discard a {W} Energy from this Pokémon, and this attack also does 40 damage to 1 of your opponent's Benched Pokémon.": ctx => {
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Water', 1);
    if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'damage', amount: 40 };
  },
  "If any of your Pokémon were Knocked Out by damage from an attack during your opponent's last turn, this attack does 60 more damage, and your opponent's Active Pokémon is now Paralyzed.": ctx => {
    if (ctx.side.lostToAttackLastOppTurn) { ctx.rawDamage += 60; if (ctx.defender) ctx.defender.status = 'paralyzed'; }
  },
  "If this Pokémon has no damage on it, this attack does 30 more damage.": ctx => { if (ctx.attacker.curHp === ctx.attacker.hp) ctx.rawDamage += 30; },
  "Heal 20 damage from each of your {P} Pokémon.": ctx => {
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(p => p && (p.types || []).includes('Psychic'))) p.curHp = Math.min(p.hp, p.curHp + 20);
  },
  "If your opponent's Active Pokémon is Confused, this attack does 70 more damage.": ctx => { if (ctx.defender?.status === 'confused') ctx.rawDamage += 70; },
  "During your opponent's next turn, this Pokémon takes +20 damage from attacks.": ctx => { ctx.attacker.selfVulnUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfVulnAmount = 20; },
  "If this Pokémon has at least 1 extra {F} Energy attached, this attack does 50 more damage.": ctx => {
    const need = (ctx.atk?.cost || []).filter(t => t === 'Fighting').length;
    if (ctx.attacker.energy.filter(e => e === 'Fighting').length > need) ctx.rawDamage += 50;
  },
  "If a Stadium is in play, this attack does 70 more damage.": ctx => { if (ctx.G.activeStadium) ctx.rawDamage += 70; },
  "During your next turn, attacks used by your {F} Pokémon do +30 damage to your opponent's Active Pokémon.": ctx => { ctx.side.typeBoostNextTurn = { type: 'Fighting', amount: 30 }; },
  "Flip a coin until you get tails. For each heads, discard the top card of your opponent's deck.": ctx => {
    let heads = 0;
    while (pocketFlipCoin(ctx)) { heads++; if (heads > 50) break; }
    for (let i = 0; i < heads && ctx.oppSide.deck.length; i++) ctx.oppSide.discard.push(ctx.oppSide.deck.shift());
  },
  "Take a {C} Energy from your Energy Zone and attach it to this Pokémon.": ctx => { if (ctx.side.pendingEnergy) { ctx.attacker.energy.push(ctx.side.pendingEnergy); ctx.side.pendingEnergy = null; } },
  "This attack does 30 damage for each of your Benched {D} Pokémon.": ctx => {
    ctx.rawDamage = 30 * ctx.side.bench.filter(p => (p.types || []).includes('Darkness')).length;
  },
  "This attack does 60 damage to 1 of your opponent's Pokémon that have damage on them.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(p => p && p.curHp < p.hp);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 60 };
  },
  "During your opponent's next turn, they can't play any Pokémon from their hand to evolve their Pokémon.": ctx => { ctx.oppSide.evolveLockedUntilTurn = ctx.G.turnNumber + 1; },
  "Discard a {D} Energy from this Pokémon.": ctx => { pocketDiscardEnergy(ctx.side, ctx.attacker, 'Darkness', 1); },
  "If any of your {D} Pokémon were Knocked Out by damage from an attack during your opponent's last turn, this attack does 80 more damage.": ctx => { if (ctx.side.lostToAttackLastOppTurn) ctx.rawDamage += 80; },
  "If your opponent has any {P} Pokémon in play, this attack does 50 more damage.": ctx => {
    if ([ctx.oppSide.active, ...ctx.oppSide.bench].some(p => p && (p.types || []).includes('Psychic'))) ctx.rawDamage += 50;
  },
  "Discard the top card of your deck.": ctx => { if (ctx.side.deck.length) ctx.side.discard.push(ctx.side.deck.shift()); },
  "Heal 30 damage from 1 of your Pokémon.": ctx => {
    const pool = [ctx.side.active, ...ctx.side.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownAll', eligibleUids: pool.map(p => p.uid), action: 'heal', amount: 30 };
  },
  "If a Stadium is in play, this attack does 20 more damage.": ctx => { if (ctx.G.activeStadium) ctx.rawDamage += 20; },
  "During your next turn, this Pokémon's Psych Up attack does +30 damage.": ctx => { ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 2; ctx.attacker.moveBuffName = 'Psych Up'; ctx.attacker.moveBuffAmount = 30; },
  "Reveal all of your Pokémon in play and in your hand that have the Puppy Pile attack, and this attack does 20 damage for each Pokémon you revealed in this way.": ctx => {
    const inPlay = [ctx.side.active, ...ctx.side.bench].filter(p => p && p.attacks?.some(a => a.name === 'Puppy Pile'));
    const inHand = ctx.side.hand.filter(c => c.attacks?.some(a => a.name === 'Puppy Pile'));
    ctx.rawDamage += (inPlay.length + inHand.length) * 20;
  },
  "Heal 10 damage from each of your Pokémon.": ctx => { for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) p.curHp = Math.min(p.hp, p.curHp + 10); },
  "Heal 30 damage from each of your Pokémon.": ctx => { for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) p.curHp = Math.min(p.hp, p.curHp + 30); },
  "This Pokémon also does 60 damage to itself.": ctx => { ctx.attacker.curHp = Math.max(0, ctx.attacker.curHp - 60); },
  "Flip 3 coins. If 1 of them is heads, this attack does 20 more damage. If 2 of them are heads, this attack does 50 more damage. If all of them are heads, this attack does 120 more damage.": ctx => {
    const heads = [1, 2, 3].filter(() => pocketFlipCoin(ctx)).length;
    if (heads === 1) ctx.rawDamage += 20; else if (heads === 2) ctx.rawDamage += 50; else if (heads === 3) ctx.rawDamage += 120;
  },
  "If this is the first time this Pokémon has used an attack after coming into play, this attack does 20 more damage, and your opponent's Active Pokémon is now Paralyzed.": ctx => {
    if (!ctx.attacker.hasAttackedSinceEnter) { ctx.rawDamage += 20; if (ctx.defender) ctx.defender.status = 'paralyzed'; }
    ctx.attacker.hasAttackedSinceEnter = true;
  },
  "Flip 2 coins. This attack does 70 damage for each heads.": ctx => {
    ctx.rawDamage = 0;
    const heads = [1, 2].filter(() => pocketFlipCoin(ctx)).length;
    ctx.rawDamage = heads * 70;
  },
  "If your opponent's Active Pokémon is a Pokémon ex, this attack does 40 more damage.": ctx => { if (ctx.defender?.ex) ctx.rawDamage += 40; },
  "This attack does 20 more damage for each {L} Energy attached to this Pokémon.": ctx => { ctx.rawDamage += ctx.attacker.energy.filter(e => e === 'Lightning').length * 20; },
  "During your next turn, the Defending Pokémon takes +50 damage from attacks.": ctx => { if (ctx.defender) { ctx.defender.selfVulnUntilTurn = ctx.G.turnNumber + 2; ctx.defender.selfVulnAmount = 50; } },
  "Flip 2 coins. If both of them are heads, discard your opponent's Active Pokémon.": ctx => {
    if (pocketFlipCoin(ctx) && pocketFlipCoin(ctx) && ctx.defender) {
      ctx.oppSide.discard.push(structuredClone(POCKET_CARDS_BY_ID[ctx.defender.id]));
      ctx.oppSide.active = null;
      ctx.rawDamage = 0;
      ctx.skipMainDamage = true;
      pocketEnterForcedSwitch(ctx.G, ctx.op, 'noEndTurn');
    }
  },
  "If this is the first time this Pokémon has used an attack after coming into play, during your opponent's next turn, they can't use any Trainer cards from their hand.": ctx => {
    if (!ctx.attacker.hasAttackedSinceEnter) { ctx.oppSide.itemLockedUntilTurn = ctx.G.turnNumber + 1; ctx.oppSide.supporterLockedUntilTurn = ctx.G.turnNumber + 1; }
    ctx.attacker.hasAttackedSinceEnter = true;
  },
  "If any of your Pokémon were Knocked Out by damage from an attack during your opponent's last turn, this attack does 50 more damage.": ctx => { if (ctx.side.lostToAttackLastOppTurn) ctx.rawDamage += 50; },
  "Switch in 1 of your opponent's Benched Pokémon to the Active Spot. If you do, this attack does 50 damage to the new Active Pokémon.": ctx => {
    ctx.rawDamage = 0;
    if (ctx.oppSide.bench.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: ctx.oppSide.bench.map(p => p.uid), action: 'switchInAndDamage', amount: 50 };
  },
  "If this Pokémon evolved from Sneasel during this turn, this attack does 20 more damage.": ctx => { if (ctx.attacker.evolveFrom === 'Sneasel' && ctx.attacker.boardTurn === ctx.G.turnNumber) ctx.rawDamage += 20; },
  "Take a random Energy from among {G}, {R}, {W}, {L}, {P}, {F}, {D}, and {M} Energy from your Energy Zone and attach it to 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) {
      const types = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal'];
      ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'attachEnergy', energyType: types[Math.floor(Math.random() * types.length)], count: 1 };
    }
  },
  "This attack does 40 more damage for each time your Pokémon have been Knocked Out during this game.": ctx => { ctx.rawDamage += (ctx.side.pokemonKnockedOutCount || 0) * 40; },
  // 波盪水「席捲巨浪」：卡面文字沒有「random」字眼，2026-08-15應使用者回報改成玩家自選要棄哪個
  // 能量——比照retreat_discard「多種能量時才暫停問玩家」的慣例，只有1種能量就不用問直接棄
  "Discard an Energy from this Pokémon, and this attack also does 20 damage to each of your opponent's Benched Pokémon.": ctx => {
    for (const p of ctx.oppSide.bench) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 20); }
    if (ctx.attacker.energy.length) {
      if (new Set(ctx.attacker.energy).size > 1) {
        ctx.needsChoice = { kind: 'attack_discard_energy', remaining: 1 };
      } else {
        const [t] = ctx.attacker.energy.splice(0, 1);
        ctx.side.discardEnergy.push(t);
      }
    }
  },
  // 「takes −30 damage」是這隻自己之後被攻擊時少受傷，跟既有「自身防禦盾」（3944行那個
  // "During your opponent's next turn, this Pokémon takes -20 damage"）同一種寫法——
  // dmgDebuffUntilTurn/dmgDebuffAmount的語意本來就是「持有旗標的這隻，下次被攻擊時少受傷N點」，
  // 不管是掛在ctx.attacker還是ctx.defender身上，一律用正數
  "Discard 2 Energy from this Pokémon. During your opponent's next turn, this Pokémon takes −30 damage from attacks.": ctx => {
    for (let i = 0; i < 2 && ctx.attacker.energy.length; i++) { const [t] = ctx.attacker.energy.splice(Math.floor(Math.random() * ctx.attacker.energy.length), 1); ctx.side.discardEnergy.push(t); }
    ctx.attacker.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.dmgDebuffAmount = 30;
  },
  "Discard all Energy from this Pokémon. Knock Out your opponent's Active Pokémon.": ctx => {
    ctx.side.discardEnergy.push(...ctx.attacker.energy);
    ctx.attacker.energy = [];
    if (ctx.defender) ctx.defender.curHp = 0;
    ctx.rawDamage = 0;
  },
  "Flip 2 coins. This attack does 60 damage for each heads.": ctx => { ctx.rawDamage = 0; const heads = [1, 2].filter(() => pocketFlipCoin(ctx)).length; ctx.rawDamage = heads * 60; },
  "If this Pokémon evolved from Dunsparce during this turn, discard 2 random Energy from your opponent's Active Pokémon.": ctx => {
    if (ctx.attacker.evolveFrom === 'Dunsparce' && ctx.attacker.boardTurn === ctx.G.turnNumber && ctx.defender) {
      for (let i = 0; i < 2 && ctx.defender.energy.length; i++) { const [t] = ctx.defender.energy.splice(Math.floor(Math.random() * ctx.defender.energy.length), 1); ctx.oppSide.discardEnergy.push(t); }
    }
  },
  "This attack does 20 more damage for each type of Energy attached to this Pokémon.": ctx => { ctx.rawDamage += new Set(ctx.attacker.energy).size * 20; },
  "If this Pokémon has a Pokémon Tool attached, this attack does 20 more damage.": ctx => { if (ctx.attacker.tool) ctx.rawDamage += 20; },
  "Flip 9 coins. This attack does 20 damage for each heads.": ctx => {
    ctx.rawDamage = 0;
    let heads = 0; for (let i = 0; i < 9; i++) if (pocketFlipCoin(ctx)) heads++;
    ctx.rawDamage = heads * 20;
  },
  "Flip a coin. If heads, this attack does 50 more damage. If tails, this Pokémon also does 50 damage to itself.": ctx => {
    if (pocketFlipCoin(ctx)) ctx.rawDamage += 50; else ctx.attacker.curHp = Math.max(0, ctx.attacker.curHp - 50);
  },
  "This attack does 30 damage for each Pokémon Tool attached to all of your Pokémon.": ctx => {
    ctx.rawDamage = 30 * [ctx.side.active, ...ctx.side.bench].filter(p => p?.tool).length;
  },
  "This attack does 40 damage for each Pokémon Tool attached to all of your Pokémon.": ctx => {
    ctx.rawDamage = 40 * [ctx.side.active, ...ctx.side.bench].filter(p => p?.tool).length;
  },
  "Choose 2 of your Benched Pokémon. For each of those Pokémon, take a {P} Energy from your Energy Zone and attach it to that Pokémon.": ctx => {
    if (ctx.side.bench.length) {
      ctx.needsChoice = { kind: 'pick_target_multi', eligibleUids: ctx.side.bench.map(p => p.uid), energyType: 'Psychic', remaining: Math.min(2, ctx.side.bench.length) };
    }
  },
  "This attack does 20 more damage for each {P} Energy attached to all of your Pokémon.": ctx => {
    const n = [ctx.side.active, ...ctx.side.bench].filter(Boolean).reduce((sum, p) => sum + p.energy.filter(e => e === 'Psychic').length, 0);
    ctx.rawDamage += n * 20;
  },
  "If this Pokémon and your opponent's Active Pokémon have 1 or more of the same type of Energy attached, this attack does 60 more damage.": ctx => {
    if (ctx.defender && ctx.attacker.energy.some(e => ctx.defender.energy.includes(e))) ctx.rawDamage += 60;
  },
  "If this Pokémon didn't move from the Bench to the Active Spot this turn, this attack does nothing.": ctx => {
    if (ctx.attacker.enteredActiveThisTurn !== ctx.G.turnNumber) ctx.rawDamage = 0;
  },
  "1 of your opponent's Active Pokémon's attacks is chosen at random. During your opponent's next turn, that Pokémon can't use the chosen attack.": ctx => {
    if (ctx.defender?.attacks?.length) {
      const atk = ctx.defender.attacks[Math.floor(Math.random() * ctx.defender.attacks.length)];
      ctx.defender.moveLockUntilTurn = ctx.G.turnNumber + 1; ctx.defender.moveLockName = atk.name;
    }
  },
  "Your opponent's Active Pokémon is now Poisoned. Do 40 damage to this Pokémon instead of the usual amount for this Special Condition.": ctx => {
    if (ctx.defender) { ctx.defender.poisoned = true; ctx.defender.poisonDamageOverride = 40; }
  },
  "This attack does 20 more damage for each Pokémon in your discard pile.": ctx => {
    ctx.rawDamage += ctx.side.discard.filter(c => c.category === 'Pokemon').length * 20;
  },
  "Put 3 random cards from among Silcoon and Cascoon from your deck onto your Bench.": ctx => {
    let placed = 0;
    while (placed < 3 && ctx.side.bench.length < 3) {
      const idxs = ctx.side.deck.map((c, i) => (['Silcoon', 'Cascoon'].includes(c.name)) ? i : -1).filter(i => i >= 0);
      if (!idxs.length) break;
      const idx = idxs[Math.floor(Math.random() * idxs.length)];
      const [card] = ctx.side.deck.splice(idx, 1);
      ctx.side.bench.push(pocketInstantiateBoardCard(card, ctx.G.turnNumber));
      placed++;
    }
    if (placed) ctx.side.deck = pocketShuffle(ctx.side.deck);
  },
  "Heal 30 damage from this Pokémon. During your opponent's next turn, the Defending Pokémon can't retreat.": ctx => {
    ctx.attacker.curHp = Math.min(ctx.attacker.hp, ctx.attacker.curHp + 30);
    if (ctx.defender) ctx.defender.cantRetreatUntilTurn = ctx.G.turnNumber + 1;
  },
  // 2026-08-09修正：原本「自動選第一張符合條件的」是誤判——「may」代表玩家可以選擇要不要
  // 棄、棄哪一隻都該由玩家決定，不是沒有策略深度（棄哪隻板凳草寶可夢當然有差）。base傷害
  // 這裡不動（維持atk.damage解析出的預設值，正常隨mainDamage結算），只用needsChoice暫停
  // 問玩家要不要棄+棄哪隻，pool='ownBench'+optional:true讓client多顯示一個「不棄」按鈕，
  // 解析邏輯見pocket_attack_choice的action==='discardForBoost'分支
  "You may discard 1 of your Benched Basic {G} Pokémon. If you do, this attack does 70 more damage.": ctx => {
    const eligible = ctx.side.bench.filter(p => p.stage === 'Basic' && (p.types || []).includes('Grass'));
    if (eligible.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: eligible.map(p => p.uid), action: 'discardForBoost', boostAmount: 70, optional: true };
  },
  "Your opponent's Active Pokémon is now Poisoned and Paralyzed. Shuffle this Pokémon and all attached cards into your deck.": ctx => {
    // 2026-08-13修正：中毒/麻痺改成獨立欄位（麻痺仍在status，中毒獨立出來）之後不再互斥，
    // 卡面文字寫的兩個狀態現在可以真的同時套用，不用再省略麻痺那一半
    if (ctx.defender) { ctx.defender.poisoned = true; ctx.defender.status = 'paralyzed'; }
    // 2026-08-11修正：原本用structuredClone(POCKET_CARDS_BY_ID[...])塞回牌庫，這份資料完全
    // 沒有uid/curHp/energy等instance欄位——之後被抽到手牌會因為uid缺失完全點不到（跟Professor
    // Turo同一類bug，見makePocketInstance才是正確建立「一張全新卡片實例」的方式）
    ctx.side.discardEnergy.push(...ctx.attacker.energy); // 洗回牌庫前，身上的能量照真實規則進棄牌堆，不是憑空消失
    ctx.attacker.energy = []; ctx.attacker.tool = null; ctx.attacker.status = null; ctx.attacker.poisoned = false; ctx.attacker.burned = false;
    ctx.side.deck = pocketShuffle([...ctx.side.deck, makePocketInstance(ctx.attacker.id)]);
    ctx.side.active = null;
    ctx.rawDamage = 0; ctx.skipMainDamage = true;
    pocketEnterForcedSwitch(ctx.G, ctx.role, 'endTurn');
  },
  "If you haven't gotten any points, this attack does 60 more damage.": ctx => { if (!ctx.side.points) ctx.rawDamage += 60; },
  "This attack does damage to your opponent's Active Pokémon equal to this Pokémon's remaining HP.": ctx => { ctx.rawDamage = ctx.attacker.curHp; },
  "Flip a coin. If heads, your opponent's Active Pokémon is now Confused. If tails, this Pokémon is now Confused.": ctx => {
    if (pocketFlipCoin(ctx)) { if (ctx.defender) ctx.defender.status = 'confused'; } else { ctx.attacker.status = 'confused'; }
  },
  "This Pokémon recovers from all Special Conditions.": ctx => { ctx.attacker.status = null; ctx.attacker.poisoned = false; ctx.attacker.burned = false; },
  "If your opponent's Active Pokémon is a {F} Pokémon, this attack does 70 more damage.": ctx => { if ((ctx.defender?.types || []).includes('Fighting')) ctx.rawDamage += 70; },
  "Discard 3 {W} Energy from this Pokémon, and this attack does 50 damage to each of your opponent's Pokémon.": ctx => {
    pocketDiscardEnergy(ctx.side, ctx.attacker, 'Water', 3);
    for (const p of [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean)) { if (!pocketSafeguardImmune(p, ctx.attacker)) p.curHp = Math.max(0, p.curHp - 50); }
    ctx.rawDamage = 0;
  },
  "Heal 10 damage from each of your Benched Pokémon.": ctx => { for (const p of ctx.side.bench) p.curHp = Math.min(p.hp, p.curHp + 10); },
  "This attack does 50 more damage for each point your opponent has gotten.": ctx => { ctx.rawDamage += (ctx.oppSide.points || 0) * 50; },
  "Discard the top card of your deck, and if that card is an Item, this attack does 20 more damage.": ctx => {
    if (ctx.side.deck.length) {
      const card = ctx.side.deck.shift();
      ctx.side.discard.push(card);
      if (card.category === 'Trainer' && card.trainerType === 'Item') ctx.rawDamage += 20;
    }
  },
  "This attack does 10 more damage for each Item card in your discard pile.": ctx => {
    ctx.rawDamage += ctx.side.discard.filter(c => c.category === 'Trainer' && c.trainerType === 'Item').length * 10;
  },
  "This attack does 20 more damage for each Energy attached to all of your opponent's Pokémon.": ctx => {
    const n = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean).reduce((sum, p) => sum + p.energy.length, 0);
    ctx.rawDamage += n * 20;
  },
  "If this Pokémon and your opponent's Active Pokémon have the same amount of Energy attached, this attack does 40 more damage.": ctx => {
    if (ctx.defender && ctx.attacker.energy.length === ctx.defender.energy.length) ctx.rawDamage += 40;
  },
  "This attack does 40 more damage for each Energy attached to your opponent's Active Pokémon.": ctx => { ctx.rawDamage += (ctx.defender?.energy.length || 0) * 40; },
  "If you have the same number of cards in your hand as your opponent, this attack does 40 more damage.": ctx => { if (ctx.side.hand.length === ctx.oppSide.hand.length) ctx.rawDamage += 40; },
  "Before doing damage, shuffle all Pokémon Tools from each of your opponent's Pokémon into their deck.": ctx => {
    for (const p of [ctx.oppSide.active, ...ctx.oppSide.bench]) {
      if (p?.tool) { ctx.oppSide.deck.push(makePocketInstance(p.tool.id)); p.tool = null; } // 2026-08-11修正：補uid，理由同上
    }
    ctx.oppSide.deck = pocketShuffle(ctx.oppSide.deck);
  },
  "During your opponent's next turn, this Pokémon takes +50 damage from attacks.": ctx => { ctx.attacker.selfVulnUntilTurn = ctx.G.turnNumber + 1; ctx.attacker.selfVulnAmount = 50; },
  "Discard all Energy from this Pokémon. Choose a spot from among your opponent's Active Spot and Bench. At the end of your opponent's next turn, Knock Out the Pokémon in the spot you chose.": ctx => {
    ctx.side.discardEnergy.push(...ctx.attacker.energy);
    ctx.attacker.energy = [];
    const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'setDelayedDamage', amount: 999 };
  },
  "Draw a card for each Poochyena you have in play.": ctx => {
    const n = [ctx.side.active, ...ctx.side.bench].filter(p => p && p.name === 'Poochyena').length;
    for (let i = 0; i < n && ctx.side.deck.length; i++) ctx.side.hand.push(ctx.side.deck.shift());
  },
  "This attack does 80 damage to 1 of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
    if (pool.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppAll', eligibleUids: pool.map(p => p.uid), action: 'damage', amount: 80 };
  },
  "If your opponent's Active Pokémon has less remaining HP than this Pokémon, this attack does 80 more damage.": ctx => {
    if (ctx.defender && ctx.defender.curHp < ctx.attacker.curHp) ctx.rawDamage += 80;
  },
  "This attack does 10 more damage for each {M} Energy attached to this Pokémon.": ctx => { ctx.rawDamage += ctx.attacker.energy.filter(e => e === 'Metal').length * 10; },
  "If this Pokémon has damage on it, this attack does 80 more damage.": ctx => { if (ctx.attacker.curHp < ctx.attacker.hp) ctx.rawDamage += 80; },
  "During your next turn, this Pokémon's Overacceleration attack does +70 damage.": ctx => { ctx.attacker.moveBuffUntilTurn = ctx.G.turnNumber + 2; ctx.attacker.moveBuffName = 'Overacceleration'; ctx.attacker.moveBuffAmount = 70; },
  "Discard all {R} and {L} Energy from this Pokémon, and this attack does 50 damage for each Energy you discarded in this way.": ctx => {
    const discarded = ctx.attacker.energy.filter(e => e === 'Fire' || e === 'Lightning');
    ctx.attacker.energy = ctx.attacker.energy.filter(e => e !== 'Fire' && e !== 'Lightning');
    ctx.side.discardEnergy.push(...discarded);
    ctx.rawDamage = discarded.length * 50;
  },
  "1 of your opponent's Pokémon is chosen at random 3 times. For each time a Pokémon was chosen, do 60 damage to it.": ctx => {
    ctx.rawDamage = 0;
    const pool = [ctx.defender, ...ctx.oppSide.bench].filter(Boolean);
    const picks = ctx.side.dracoMeteorExtraThisTurn ? 4 : 3;
    ctx.side.dracoMeteorExtraThisTurn = false;
    for (let i = 0; i < picks && pool.length; i++) { const t = pool[Math.floor(Math.random() * pool.length)]; t.curHp = Math.max(0, t.curHp - 60); }
  },
  "Flip 2 coins. If both of them are heads, this attack does 100 more damage.": ctx => { if (pocketFlipCoin(ctx) && pocketFlipCoin(ctx)) ctx.rawDamage += 100; },
  // 簡化：真實規則玩家可以自選怎麼分配，這個引擎沒有「多來源多去向」的能量搬移UI——
  // 簡化成把攻擊者身上全部能量移到玩家自選的1隻板凳（跟既有moveAllEnergyFromAttacker同一套）
  "You may move any amount of Energy from your Pokémon in play to your other Pokémon in any way you like.": ctx => {
    if (ctx.attacker.energy.length && ctx.side.bench.length) {
      ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: ctx.side.bench.map(p => p.uid), action: 'moveAllEnergyFromAttacker', noEndTurn: false };
    }
  },
  "If this Pokémon and your opponent's Active Pokémon have 1 or more of the same type of Energy attached, this attack does 30 more damage.": ctx => {
    if (ctx.defender && ctx.attacker.energy.some(e => ctx.defender.energy.includes(e))) ctx.rawDamage += 30;
  },
  "If your opponent's Active Pokémon is a Pokémon ex, this attack does 90 more damage.": ctx => { if (ctx.defender?.ex) ctx.rawDamage += 90; },
  // Fan Made系列（2026-08-10新增，見pocket-tcg skill）：使用者自製卡，效果文字本身就是中文
  // （不是TCGdex來源），跟其餘卡池的英文key不一致是刻意的——卡圖本身全中文，detail panel
  // 顯示這段文字時要跟卡面一致，不能直接借用既有的英文key（雖然邏輯完全相同）。
  "這隻寶可夢也受到30點傷害。": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 30; }, // 捷克羅姆ex「野性電擊」
  "可給予1隻自己的板凳火屬性寶可夢1個火屬性能量。": ctx => { // 萊希拉姆ex「青焰」——直接生成能量，不扣能量區
    const targets = ctx.side.bench.filter(p => (p.types || []).includes('Fire'));
    if (targets.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownBench', eligibleUids: targets.map(p => p.uid), action: 'attachEnergy', energyType: 'Fire', count: 1 };
  },
  // 酋雷姆ex「絕對零度」（2026-08-12新增）：跟既有英文卡「If your opponent's Active Pokémon is
  // an Evolution Pokémon, this attack does 40 more damage.」同一種stage!=='Basic'判斷，只是
  // 額外傷害改成60，中文key的理由跟上面兩張同一批Fan Made卡一致
  "若對手的戰鬥寶可夢為進化寶可夢，則增加60點傷害。": ctx => { if (ctx.defender && ctx.defender.stage !== 'Basic') ctx.rawDamage += 60; },
};
// 場上所有寶可夢（雙方主戰+板凳）裡隨機選n次、每次隨機丟掉1點能量——「both yours and your
// opponent's」代表池子橫跨雙方場面，不是各自獨立各丟一次，且身上沒能量的寶可夢不會被選中
// 2026-08-12修正：棄掉的能量原本直接splice消失，沒有進discardEnergy——跟pocketDiscardEnergy
// 同一個架構缺口（這兩個是「隨機選」版本，各自獨立實作、沒有共用pocketDiscardEnergy，所以
// 當初那批19處call site的sweep沒有掃到這裡）。池子橫跨雙方，要記住挑到的寶可夢屬於哪一側
// 才能塞進正確的discardEnergy（棄掉的能量固定進「能量原本掛著的那隻」所屬той一方）。
function pocketDiscardRandomEnergyInPlay(G, n) {
  for (let i = 0; i < n; i++) {
    const pool = [
      ...[G.p1.active, ...G.p1.bench].filter(p => p && p.energy.length).map(p => ({ p, side: G.p1 })),
      ...[G.p2.active, ...G.p2.bench].filter(p => p && p.energy.length).map(p => ({ p, side: G.p2 })),
    ];
    if (!pool.length) return;
    const { p, side } = pool[Math.floor(Math.random() * pool.length)];
    const [type] = p.energy.splice(Math.floor(Math.random() * p.energy.length), 1);
    side.discardEnergy.push(type);
  }
}
// Gaia Blast（2026-08-08新增）：跟pocketDiscardRandomEnergyInPlay同一套邏輯，但池子只限own side
// （"from among the Energy attached to all of YOUR Pokémon"，沒有"both yours and your opponent's"字樣）
// 2026-08-12同上修正discardEnergy缺口
function pocketDiscardRandomEnergyOwnSide(side, n) {
  for (let i = 0; i < n; i++) {
    const pool = [side.active, ...side.bench].filter(p => p && p.energy.length);
    if (!pool.length) return;
    const p = pool[Math.floor(Math.random() * pool.length)];
    const [type] = p.energy.splice(Math.floor(Math.random() * p.energy.length), 1);
    side.discardEnergy.push(type);
  }
}
// 2026-08-08新增side參數：被棄置的能量原本直接消失，跟Rainbow Cave那次同一個問題——真實
// 規則棄掉的能量會進棄牌堆、可以被Dragon's Blessing這類「從棄牌堆挖能量」的效果撿回。
// side是「能量原本掛的那隻寶可夢所屬的一方」（不一定是ctx.side——例如Squirt Bottle棄的是
// 對手身上的能量，要塞進ctx.oppSide.discardEnergy，不是ctx.side的）
function pocketDiscardEnergy(side, pokemon, type, n) {
  for (let i = 0; i < n; i++) {
    const idx = pokemon.energy.indexOf(type);
    if (idx >= 0) { pokemon.energy.splice(idx, 1); side.discardEnergy.push(type); }
  }
}
// 2026-08-12新增：把pocket_retreat「真的執行換人」的部分拆成共用函式——原本的撤退能量成本
// 永遠是自動splice(0,cost)、不會暫停，這次改成能量種類不只1種時要先暫停等玩家選（見
// pocket_retreat handler跟pocket_attack_choice的'retreat_discard'分支），所以「選完能量之後
// 才真正換人上場」跟「不用選、付完能量立刻換人上場」這兩條路徑需要共用同一段換人邏輯，
// 不能再直接寫死在pocket_retreat handler裡一路到底。
function pocketFinalizeRetreat(G, role, benchUid) {
  const side = G[role];
  const active = side.active;
  const idx = side.bench.findIndex(p => p.uid === benchUid);
  if (idx < 0) return;
  // 真實規則：異常狀態（中毒等）只作用在主戰位置，撤退到板凳時要清除——不然中毒的寶可夢
  // 撤退後status還留著，之後又換回主戰時會被誤判成「重新中毒」，繼續扣血。
  active.status = null; active.poisoned = false; active.burned = false;
  active.stackBuffName = null; active.stackBuffAmount = 0; // Miltank/Mega Mawile ex
  active._abilitiesLockedOff = false; // Prickly Powder：離開主戰位置時解除特性封鎖
  const target = side.bench[idx];
  target.enteredActiveThisTurn = G.turnNumber; // Golisopod/Scizor/Basculin
  side.bench[idx] = active;
  side.active = target;
  side.retreatedThisTurn = true;
  const oppSide = G[role === 'p1' ? 'p2' : 'p1'];
  // Galarian Stunfisk：對手主戰身上種的「我方撤退時打新主戰」陷阱
  if (oppSide.active?.retreatTrapUntilTurn === G.turnNumber) {
    target.curHp = Math.max(0, target.curHp - (oppSide.active.retreatTrapAmount || 0));
    // 2026-08-16應使用者回報一併修正：撤退本身是免費行動、不結束回合，這裡被陷阱擊倒也不該
    // 連帶結束回合（同一個道理見Nightmare Aura/Electromagnetic Wall的修正）
    if (target.curHp <= 0) pocketResolveActiveKO(G, role, true, false);
  }
}

/* ── 訓練師卡效果表（Phase 5）── key用卡片id（同名重印卡id不同，統一用A1原版/PromoA原版的id）
   handler簽名：(ctx, msg) => string|null，回傳錯誤訊息字串代表不合法擋下，null代表成功。 */
const TRAINER_EFFECTS = {
  'P-A-001': (ctx, msg) => { // Potion：治療己方1隻20血
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要治療的寶可夢';
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 20);
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  'P-A-002': (ctx) => { ctx.side.retreatDiscountThisTurn = 1; return null; }, // X Speed
  'P-A-003': (ctx) => { ctx.peekHand = ctx.oppSide.hand; return null; }, // Hand Scope
  'P-A-004': (ctx) => { ctx.peekDeck = ctx.side.deck.slice(0, 3); return null; }, // Pokédex
  'P-A-005': (ctx) => { // Poké Ball
    // 2026-08-06修正：原本牌庫沒有基礎寶可夢時直接擋下不給打（回傳錯誤訊息，卡片不會被消耗）。
    // 使用者要求改成「即便沒有基礎寶可夢也可以用」——卡片照樣打出、照樣進棄牌堆，只是這次抽空，
    // 不算不合法操作。這裡不return錯誤字串，讓外層handler照常把卡片從手牌移到棄牌堆。
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Pokemon' && c.stage === 'Basic') ? i : -1).filter(i => i >= 0);
    if (idxs.length) {
      const i = idxs[Math.floor(Math.random() * idxs.length)];
      ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]);
    }
    return null;
  },
  'P-A-006': (ctx) => { // Red Card：對手棄手牌洗回牌庫抽3
    ctx.oppSide.deck = pocketShuffle([...ctx.oppSide.deck, ...ctx.oppSide.hand]);
    ctx.oppSide.hand = ctx.oppSide.deck.splice(0, 3);
    return null;
  },
  'P-A-007': (ctx) => { ctx.side.hand.push(...ctx.side.deck.splice(0, 2)); return null; }, // Professor's Research
  'A1-219': (ctx, msg) => { // Erika：治療己方1隻草屬性50血
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || !(target.types || []).includes('Grass')) return '目標必須是草屬性寶可夢';
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 50);
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  'A1-220': (ctx, msg) => { // Misty（使用者自訂調整，2026-08-17）：原本限定水屬性，改成任意寶可夢
    // 都能選，連續丟硬幣直到反面，正面各+1水能量
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇己方場上的寶可夢';
    while (pocketFlipCoin(ctx)) target.energy.push('Water');
    return null;
  },
  'A1-221': (ctx) => { ctx.side.blaineBoostNamesThisTurn = ['Ninetales', 'Rapidash', 'Magmar']; return null; },
  'A1-222': (ctx) => { // Koga：把主戰的Muk/Weezing收回手牌（需要有板凳補上，否則擋下避免場上淨空）
    if (!ctx.side.active || !['Muk', 'Weezing'].includes(ctx.side.active.name)) return '主戰必須是Muk或Weezing';
    if (!ctx.side.bench.length) return '沒有板凳寶可夢可以補位，無法使用';
    ctx.side.hand.push(ctx.side.active);
    ctx.side.active = ctx.side.bench.shift();
    return null;
  },
  'A1-223': (ctx) => { ctx.side.giovanniBoostThisTurn = true; return null; },
  'A1-224': (ctx, msg) => { // Brock（使用者自訂調整，2026-08-17）：原本限定Golem/Onix，改成
    // 任何格鬥屬性寶可夢——場上可能不只1隻符合，改成玩家自選（見client端TRAINER_NEEDS_TARGET，
    // 會先跳目標選擇器，這裡收到的msg.target就是玩家選好的uid）
    const target = [ctx.side.active, ...ctx.side.bench].find(p => p && p.uid === msg.target && (p.types || []).includes('Fighting'));
    if (!target) return '請選擇己方場上的格鬥屬性寶可夢';
    target.energy.push('Fighting');
    return null;
  },
  'A1-225': (ctx) => { // Sabrina：把對手主戰換到板凳，對手選新主戰
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    // 2026-08-12修正：excludeUid排除「剛被換下來的那隻」——使用者回報如果對手板凳還有其他選項，
    // 不該讓對手選回同一隻（那樣等於這張卡沒發生任何事）。真的沒有其他板凳選項時，
    // pocket_choose_active handler會放行選回同一隻，不會卡死在forced_switch選不到目標。
    const excludedUid = ctx.oppSide.active.uid;
    ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false; // 異常狀態只作用在主戰位置，離開主戰要清除（同撤退那邊的理由）
    ctx.oppSide.bench.push(ctx.oppSide.active);
    ctx.oppSide.active = null;
    pocketEnterForcedSwitch(ctx.G, ctx.op, 'noEndTurn', excludedUid); // 支援者卡不會結束回合，換完人回合還是你的
    return null;
  },
  'A1-226': (ctx) => { // Lt. Surge：把所有板凳的電能量集中給主戰（限主戰是Raichu/Electrode/Electabuzz）
    if (!ctx.side.active || !['Raichu', 'Electrode', 'Electabuzz'].includes(ctx.side.active.name)) return '主戰必須是Raichu、Electrode或Electabuzz';
    for (const p of ctx.side.bench) {
      const moved = p.energy.filter(e => e === 'Lightning');
      if (moved.length) { p.energy = p.energy.filter(e => e !== 'Lightning'); ctx.side.active.energy.push(...moved); }
    }
    return null;
  },

  /* ── 2026-08-06新增：場地卡（Stadium）——只做效果清楚的2張，另外2張（Starting Plains
     全體基礎寶可夢+20HP、Mesagoza每回合可選擇擲硬幣的常駐主動效果）分別需要「動態最大HP」跟
     「場地本身的每回合主動觸發」這兩種目前engine完全沒有的機制，先不做，卡片停留在「尚未支援」。
     場地卡沒有「己方/對方」之分，蓋在G.activeStadium上是全場共用，兩邊都受影響。 */
  'B2-153': (ctx) => { ctx.G.activeStadium = { id: 'B2-153', name: 'Training Area' }; return null; }, // 訓練場：雙方Stage1攻擊+10
  'B2-155': (ctx) => { ctx.G.activeStadium = { id: 'B2-155', name: 'Peculiar Plaza' }; return null; }, // 奇異廣場：雙方超能力寶可夢撤退-2
  // Starting Plains（2026-08-08新增）：雙方基礎階+20HP，實際加成邏輯在pocketSyncHpBonuses
  // （動態HP機制），這裡只負責設場地卡本身
  'B2-154': (ctx) => { ctx.G.activeStadium = { id: 'B2-154', name: 'Starting Plains' }; return null; },
  // Mesagoza：場地本身只負責蓋上去，主動觸發的效果走獨立的'pocket_use_stadium'訊息（見那裡）
  'B2a-093': (ctx) => { ctx.G.activeStadium = { id: 'B2a-093', name: 'Mesagoza' }; return null; },

  /* ── 2026-08-06新增：道具卡（Item）第一批 ── */
  // 2026-08-06修正（使用者第二次糾正）：原本擲硬幣正面就隨機挑1隻板凳電系附加，改成玩家
  // 先選好目標（跟Potion/Erika同一套msg.target流程），server只負責擲硬幣決定成不成功，
  // 不再自己選target——「選哪隻」跟「有沒有成功」是兩件獨立的事，卡面只有後者才寫了機率。
  'B2a-086': (ctx, msg) => { // Electric Generator
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || !(target.types || []).includes('Lightning') || !ctx.side.bench.some(p => p.uid === target.uid)) {
      return '目標必須是板凳上的電屬性寶可夢';
    }
    if (pocketFlipCoin(ctx)) target.energy.push('Lightning');
    return null;
  },
  'A1a-065': (ctx) => { // Mythical Slab：看牌庫頂1張，是超能力寶可夢就進手牌，不是就放牌庫底
    if (!ctx.side.deck.length) return null;
    const top = ctx.side.deck[0];
    if (top.category === 'Pokemon' && (top.types || []).includes('Psychic')) {
      ctx.side.hand.push(ctx.side.deck.shift());
    } else {
      ctx.side.deck.push(ctx.side.deck.shift());
    }
    return null;
  },
  // 2026-08-06修正：原本從對手棄牌堆隨機挑1隻基礎寶可夢，改成玩家自己從對手棄牌堆的清單裡選
  // （client端用discard-target-picker挑，不是board目標）——是「你」在使用這張卡，效果動詞
  // 是「Put」，沒有註明「your opponent puts/chooses」，比照Sabrina既有的「沒特別註明就是
  // 操作方自選」慣例，目標由你來挑,不是隨機也不是對手選
  'A1a-064': (ctx, msg) => { // Pokémon Flute
    if (ctx.oppSide.bench.length >= 3) return '對手板凳已滿';
    const idx = ctx.oppSide.discard.findIndex(c => c.uid === msg.target && c.category === 'Pokemon' && c.stage === 'Basic');
    if (idx < 0) return '目標必須是對手棄牌堆裡的基礎寶可夢';
    const p = ctx.oppSide.discard.splice(idx, 1)[0];
    p.curHp = p.hp; p.energy = []; p.status = null; p.poisoned = false; p.burned = false; p.boardTurn = ctx.G.turnNumber;
    ctx.oppSide.bench.push(p);
    return null;
  },
  'A4-152': (ctx) => { pocketDiscardEnergy(ctx.oppSide, ctx.oppSide.active, 'Fire', 1); return null; }, // Squirt Bottle（卡面原文就是{R}不是{W}，照實作）
  'B1-215': (ctx) => { // Hitting Hammer：連續2枚都正面才丟能量（丟哪一點能量文字本身就寫"a random Energy"，維持隨機）
    const h1 = pocketFlipCoin(ctx), h2 = pocketFlipCoin(ctx);
    if (h1 && h2 && ctx.oppSide.active?.energy.length) {
      const [t] = ctx.oppSide.active.energy.splice(Math.floor(Math.random() * ctx.oppSide.active.energy.length), 1);
      ctx.oppSide.discardEnergy.push(t);
    }
    return null;
  },
  // 2026-08-06修正：原本隨機挑1隻帶R/W/L能量的板凳，改成玩家自己選要從哪隻板凳移能量
  'A4-151': (ctx, msg) => { // Elemental Switch
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const movable = ['Fire', 'Water', 'Lightning'];
    const target = ctx.side.bench.find(p => p.uid === msg.target);
    if (!target || !target.energy.some(e => movable.includes(e))) return '目標必須是身上帶著火/水/電能量的板凳寶可夢';
    const type = target.energy.find(e => movable.includes(e));
    target.energy.splice(target.energy.indexOf(type), 1);
    ctx.side.active.energy.push(type);
    return null;
  },
  'A3-142': (ctx) => { // Big Malasada：主戰回10血+隨機解除1個異常狀態——2026-08-13修正：卡面
    // 原文是「remove A RANDOM Special Condition」，原本錯當成「解除全部」且只認status這一格，
    // 中毒/灼傷獨立成欄位後改用pocketRemoveRandomCondition（跟Happiness Supplement共用同一套邏輯）
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const before = ctx.side.active.curHp;
    ctx.side.active.curHp = Math.min(ctx.side.active.hp, ctx.side.active.curHp + 10);
    pocketRemoveRandomCondition(ctx.side.active);
    ctx.healUid = ctx.side.active.uid; ctx.healAmount = ctx.side.active.curHp - before;
    return null;
  },
  'A3-143': (ctx) => { // Fishing Net：從己方棄牌堆隨機挑1隻基礎水系放進手牌
    const idxs = ctx.side.discard.map((c, i) => (c.category === 'Pokemon' && c.stage === 'Basic' && (c.types || []).includes('Water')) ? i : -1).filter(i => i >= 0);
    if (!idxs.length) return null;
    const i = idxs[Math.floor(Math.random() * idxs.length)];
    ctx.side.hand.push(ctx.side.discard.splice(i, 1)[0]);
    return null;
  },
  // Rotom Dex：只做「看牌庫頂1張」的部分，"you may shuffle your deck"沒有UI可以讓玩家決定
  // 要不要洗牌，刻意不做那一半（不洗＝安全的保守選擇，洗牌對玩家沒有淨損失風險）
  'A3-145': (ctx) => { if (ctx.side.deck.length) ctx.peekDeck = [ctx.side.deck[0]]; return null; },
  'A3a-064': (ctx) => { // Repel：對手主戰必須是基礎寶可夢才能發動
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    if (ctx.oppSide.active.stage !== 'Basic') return '對手主戰不是基礎寶可夢，無法使用';
    if (!ctx.oppSide.bench.length) return '對手沒有板凳寶可夢可以換上';
    const excludedUid = ctx.oppSide.active.uid; // 見Sabrina(A1-225)同一處excludeUid說明
    ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false;
    ctx.oppSide.bench.push(ctx.oppSide.active);
    ctx.oppSide.active = null;
    pocketEnterForcedSwitch(ctx.G, ctx.op, 'noEndTurn', excludedUid);
    return null;
  },
  'B1a-066': (ctx) => { ctx.side.namedBoostThisTurn = { names: ['Magneton', 'Heliolisk'], amount: 20 }; return null; }, // Clemont's Backpack

  /* ── 2026-08-07新增：支援者卡（Supporter）第一批——依全卡池出現頻率排序挑選 ── */
  // Iono：雙方各自洗手牌回牌庫再抽回原本張數。這張卡本身此時還在side.hand裡（外層handler
  // 要等這裡return之後才會把它移到棄牌堆），所以「己方的手牌」要先扣掉Iono自己這張再洗，
  // 不然會把正在使用中的這張卡也一起洗進牌庫——用msg.handUid精準排除，外層事後的
  // side.hand.filter(uid)/discard.push(card)在全新抽好的hand陣列上找不到舊uid會是no-op，
  // 不影響剛抽到的新手牌，最後card物件參照依然正確進到棄牌堆。
  'A2b-069': (ctx, msg) => {
    const myRest = ctx.side.hand.filter(c => c.uid !== msg.handUid);
    ctx.side.deck = pocketShuffle([...ctx.side.deck, ...myRest]);
    ctx.side.hand = ctx.side.deck.splice(0, myRest.length);
    const oppCount = ctx.oppSide.hand.length;
    ctx.oppSide.deck = pocketShuffle([...ctx.oppSide.deck, ...ctx.oppSide.hand]);
    ctx.oppSide.hand = ctx.oppSide.deck.splice(0, oppCount);
    return null;
  },
  'A3-155': (ctx, msg) => { // Lillie：治療己方1隻二階寶可夢60血
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || target.stage !== 'Stage2') return '目標必須是二階寶可夢';
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 60);
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  'B2a-091': (ctx) => { // Arven：擲硬幣，正面隨機道具卡進手牌，反面隨機寶可夢工具卡進手牌
    const wantType = pocketFlipCoin(ctx) ? 'Item' : 'Tool';
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Trainer' && c.trainerType === wantType) ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); }
    return null;
  },
  // Blue/Adaman/Jasmine：「對手下回合，己方(符合條件的)全體寶可夢受到的傷害-N」——蓋在
  // 「現在場上這些寶可夢」的dmgDebuffUntilTurn/dmgDebuffAmount上（跟招式那組自身減傷欄位共用），
  // 之後才上場的不會補上這個buff，跟卡面「all of your Pokémon」讀作「打出當下場上這些」一致
  'A1a-067': (ctx) => { // Blue（使用者自訂調整，2026-08-17）：原本-10改成-80
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) {
      p.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; p.dmgDebuffAmount = 80;
    }
    return null;
  },
  'A2a-075': (ctx) => { // Adaman：己方鋼屬性-20
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(p => p && (p.types || []).includes('Metal'))) {
      p.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; p.dmgDebuffAmount = 20;
    }
    return null;
  },
  'A4-160': (ctx) => { // Jasmine：己方Steelix/Skarmory ex -50
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(p => p && ['Steelix', 'Skarmory ex'].includes(p.name))) {
      p.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; p.dmgDebuffAmount = 50;
    }
    return null;
  },
  'A2-152': (ctx) => { ctx.side.namedBoostThisTurn = { names: ['Garchomp', 'Togekiss'], amount: 50 }; return null; }, // Cynthia
  'A3-153': (ctx) => { ctx.side.namedBoostThisTurn = { names: ['Alolan Golem', 'Vikavolt', 'Togedemaru'], amount: 30 }; return null; }, // Sophocles
  'A3b-068': (ctx) => { ctx.side.namedBoostThisTurn = { names: ['Decidueye ex', 'Incineroar ex', 'Primarina ex'], amount: 30 }; return null; }, // Hau
  'B2a-090': (ctx) => { ctx.side.namedBoostThisTurn = { names: ['Pawmot'], amount: 80, exOnly: true }; return null; }, // Nemona：限定對手主戰是ex才加成
  'A2b-071': (ctx) => { ctx.side.exOnlyBoostThisTurn = 20; return null; }, // Red：不限定寶可夢，限定目標是ex
  'A2-154': (ctx, msg) => { // Dawn：把1隻板凳身上的任意1點能量移給主戰（板凳由玩家指定，能量種類自動挑該寶可夢身上現有的）
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const target = ctx.side.bench.find(p => p.uid === msg.target);
    if (!target || !target.energy.length) return '請選擇板凳上帶著能量的寶可夢';
    const type = target.energy[0];
    target.energy.splice(0, 1);
    ctx.side.active.energy.push(type);
    return null;
  },
  'A2-153': (ctx, msg) => { // Volkner：選場上的Electivire/Luxray，從棄牌堆拿2電能量附加
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || !['Electivire', 'Luxray'].includes(target.name)) return '目標必須是Electivire或Luxray';
    let moved = 0;
    if (pocketTakeEnergyFromDiscard(ctx.side, 'Lightning')) moved++;
    if (pocketTakeEnergyFromDiscard(ctx.side, 'Lightning')) moved++;
    for (let i = 0; i < moved; i++) target.energy.push('Lightning');
    return null;
  },
  'B1-224': (ctx) => { // Fantina：從能量區各拿1超能力能量給場上每隻Drifblim跟Mismagius
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(p => p && ['Drifblim', 'Mismagius'].includes(p.name))) {
      p.energy.push('Psychic');
    }
    return null;
  },
  'A2b-070': (ctx, msg) => { // Pokémon Center Lady：治療己方1隻30血+清除全部異常狀態
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇目標寶可夢';
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 30);
    target.status = null;
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  'B1-221': (ctx, msg) => { // Marlon：治療己方1隻Carracosta/Jellicent 70血
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || !['Carracosta', 'Jellicent'].includes(target.name)) return '目標必須是Carracosta或Jellicent';
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 70);
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  'A4a-069': (ctx, msg) => { // Whitney：治療己方1隻Miltank 60血，解除睡眠/麻痺/混亂（不含中毒/灼傷）
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || target.name !== 'Miltank') return '目標必須是Miltank';
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 60);
    if (['asleep', 'paralyzed', 'confused'].includes(target.status)) target.status = null;
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  'A3-154': (ctx, msg) => { // Mallow：己方1隻Shiinotic/Tsareena全回血，並丟棄它身上全部能量
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || !['Shiinotic', 'Tsareena'].includes(target.name)) return '目標必須是Shiinotic或Tsareena';
    const before = target.curHp;
    target.curHp = target.hp;
    ctx.side.discardEnergy.push(...target.energy);
    target.energy = [];
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  'B2-149': (ctx, msg) => { // Diantha：己方1隻超能力+至少2點超能力能量的寶可夢，治療90血，成功的話丟棄2點超能力能量
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || !(target.types || []).includes('Psychic') || target.energy.filter(e => e === 'Psychic').length < 2) {
      return '目標必須是身上帶著至少2點超能力能量的超能力寶可夢';
    }
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 90);
    if (target.curHp > before) { pocketDiscardEnergy(ctx.side, target, 'Psychic', 2); }
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  'A2-151': (ctx) => { // Team Galactic Grunt：牌庫隨機1隻Glameow/Stunky/Croagunk進手牌
    const idxs = ctx.side.deck.map((c, i) => ['Glameow', 'Stunky', 'Croagunk'].includes(c.name) ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); }
    return null;
  },
  'A2a-073': (ctx) => { // Celestic Town Elder：己方棄牌堆隨機1隻基礎寶可夢進手牌
    const idxs = ctx.side.discard.map((c, i) => (c.category === 'Pokemon' && c.stage === 'Basic') ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.discard.splice(i, 1)[0]); }
    return null;
  },
  'A3a-067': (ctx) => { // Gladion：牌庫隨機1隻Type: Null或Silvally進手牌
    const idxs = ctx.side.deck.map((c, i) => ['Type: Null', 'Silvally'].includes(c.name) ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); }
    return null;
  },
  'B1-225': (ctx, msg) => { // Copycat：洗手牌回牌庫，抽跟對手手牌等量的牌（同Iono要排除自己這張）
    const myRest = ctx.side.hand.filter(c => c.uid !== msg.handUid);
    const drawCount = ctx.oppSide.hand.length;
    ctx.side.deck = pocketShuffle([...ctx.side.deck, ...myRest]);
    ctx.side.hand = ctx.side.deck.splice(0, Math.min(drawCount, ctx.side.deck.length));
    return null;
  },
  'A2-155': (ctx) => { // Mars：對手洗手牌回牌庫，抽「距離贏還差幾分」張牌
    const drawCount = Math.max(0, 3 - ctx.oppSide.points);
    ctx.oppSide.deck = pocketShuffle([...ctx.oppSide.deck, ...ctx.oppSide.hand]);
    ctx.oppSide.hand = ctx.oppSide.deck.splice(0, Math.min(drawCount, ctx.oppSide.deck.length));
    return null;
  },
  'A2b-072': (ctx) => { // Team Rocket Grunt：連續丟到反面為止，每次正面丟掉對手主戰1點隨機能量
    while (pocketFlipCoin(ctx)) {
      if (!ctx.oppSide.active?.energy.length) break;
      const [t] = ctx.oppSide.active.energy.splice(Math.floor(Math.random() * ctx.oppSide.active.energy.length), 1);
      ctx.oppSide.discardEnergy.push(t);
    }
    return null;
  },
  'A1a-066': (ctx) => { // Budding Expeditioner：主戰必須是Mew ex，收回手牌（需要板凳補位，同Koga的邏輯）
    if (!ctx.side.active || ctx.side.active.name !== 'Mew ex') return '主戰必須是Mew ex';
    if (!ctx.side.bench.length) return '沒有板凳寶可夢可以補位，無法使用';
    ctx.side.hand.push(ctx.side.active);
    ctx.side.active = ctx.side.bench.shift();
    return null;
  },
  'A3-149': (ctx, msg) => { // Ilima：己方1隻身上有傷的無色寶可夢收回手牌（若是主戰，需要板凳補位）
    const target = [ctx.side.active, ...ctx.side.bench].find(p => p && p.uid === msg.target);
    if (!target || !(target.types || []).includes('Colorless') || target.curHp >= target.hp) {
      return '目標必須是身上有傷的無色寶可夢';
    }
    if (ctx.side.active?.uid === target.uid) {
      if (!ctx.side.bench.length) return '沒有板凳寶可夢可以補位，無法使用';
      ctx.side.active = ctx.side.bench.shift();
    } else {
      ctx.side.bench = ctx.side.bench.filter(p => p.uid !== target.uid);
    }
    target.curHp = target.hp; target.energy = []; target.status = null; target.poisoned = false; target.burned = false;
    ctx.side.hand.push(target);
    return null;
  },
  'A4-157': (ctx, msg) => { // Lyra：主戰必須有傷，跟玩家指定的板凳互換
    if (!ctx.side.active || ctx.side.active.curHp >= ctx.side.active.hp) return '主戰必須是身上有傷的寶可夢';
    const idx = ctx.side.bench.findIndex(p => p.uid === msg.target);
    if (idx < 0) return '請選擇板凳上的目標';
    const bench = ctx.side.bench[idx];
    const oldActive = ctx.side.active;
    oldActive.status = null; oldActive.poisoned = false; oldActive.burned = false;
    ctx.side.bench[idx] = oldActive;
    ctx.side.active = bench;
    return null;
  },
  'A4a-070': (ctx) => { // Traveling Merchant：看牌庫頂4張，把裡面的寶可夢工具卡收進手牌，其餘洗回牌庫
    const top = ctx.side.deck.splice(0, 4);
    const tools = top.filter(c => c.category === 'Trainer' && c.trainerType === 'Tool');
    const rest = top.filter(c => !tools.includes(c));
    ctx.side.hand.push(...tools);
    ctx.side.deck = pocketShuffle([...ctx.side.deck, ...rest]);
    return null;
  },
  'B2-150': (ctx) => { // Sightseer：看牌庫頂4張，把裡面的一階寶可夢收進手牌，其餘洗回牌庫
    const top = ctx.side.deck.splice(0, 4);
    const stage1s = top.filter(c => c.category === 'Pokemon' && c.stage === 'Stage1');
    const rest = top.filter(c => !stage1s.includes(c));
    ctx.side.hand.push(...stage1s);
    ctx.side.deck = pocketShuffle([...ctx.side.deck, ...rest]);
    return null;
  },
  'A3a-068': (ctx) => { // Looker：公開對手牌庫裡全部的支援者卡（唯讀，不改變牌庫內容/順序）
    ctx.peekDeck = ctx.oppSide.deck.filter(c => c.trainerType === 'Supporter');
    return null;
  },
  'A4-159': (ctx) => { // Fisher：丟3枚硬幣，每次正面從己方棄牌堆隨機挑1隻水系寶可夢進手牌
    const heads = pocketFlipCoins(3, ctx);
    for (let i = 0; i < heads; i++) {
      const idxs = ctx.side.discard.map((c, j) => (c.category === 'Pokemon' && (c.types || []).includes('Water')) ? j : -1).filter(j => j >= 0);
      if (!idxs.length) break;
      const j = idxs[Math.floor(Math.random() * idxs.length)];
      ctx.side.hand.push(ctx.side.discard.splice(j, 1)[0]);
    }
    return null;
  },
  'B2-152': (ctx) => { // Piers：場上必須有己方的Galarian Obstagoon，丟棄對手主戰2點隨機能量
    const has = [ctx.side.active, ...ctx.side.bench].some(p => p && p.name === 'Galarian Obstagoon');
    if (!has) return '場上必須有己方的Galarian Obstagoon';
    for (let i = 0; i < 2 && ctx.oppSide.active?.energy.length; i++) {
      const [t] = ctx.oppSide.active.energy.splice(Math.floor(Math.random() * ctx.oppSide.active.energy.length), 1);
      ctx.oppSide.discardEnergy.push(t);
    }
    return null;
  },
  'B2-151': (ctx) => { // Juggler：己方場上寶可夢身上的能量種類必須有3種以上，把全部板凳能量集中給主戰
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const allTypes = new Set([ctx.side.active, ...ctx.side.bench].flatMap(p => p.energy));
    if (allTypes.size < 3) return '己方場上寶可夢身上帶的能量種類必須有3種以上';
    for (const p of ctx.side.bench) { ctx.side.active.energy.push(...p.energy); p.energy = []; }
    return null;
  },
  'B2a-088': (ctx) => { // Team Star Grunt：對手場上「有特性」的寶可夢，把它們身上所有能量攤平成一個池子，均勻隨機丟棄其中1點
    const flat = [];
    for (const p of [ctx.oppSide.active, ...ctx.oppSide.bench].filter(p => p && p.abilities?.length)) {
      p.energy.forEach((_, i) => flat.push([p, i]));
    }
    if (!flat.length) return null;
    const [p, i] = flat[Math.floor(Math.random() * flat.length)];
    const [t] = p.energy.splice(i, 1);
    ctx.oppSide.discardEnergy.push(t);
    return null;
  },
  // Hiker/Morty："look at...and put them back in any order"——只做「看」的部分，重新排序
  // 沒有UI可以讓玩家實際操作，牌庫順序原封不動放回去(splice(0,n)+unshift回去)，不算竄改內容
  'A4-161': (ctx) => { // Hiker：依己方場上格鬥寶可夢數量，看牌庫頂那麼多張
    const n = [ctx.side.active, ...ctx.side.bench].filter(p => p && (p.types || []).includes('Fighting')).length;
    if (n > 0) ctx.peekDeck = ctx.side.deck.slice(0, n);
    return null;
  },
  'A4a-071': (ctx) => { // Morty：依己方場上超能力寶可夢數量，看對手牌庫頂那麼多張
    const n = [ctx.side.active, ...ctx.side.bench].filter(p => p && (p.types || []).includes('Psychic')).length;
    if (n > 0) ctx.peekDeck = ctx.oppSide.deck.slice(0, n);
    return null;
  },

  // ── 支援者/道具卡第二批（2026-08-07再接續，跟Tool系統同一批）──
  'A1a-068': (ctx) => { ctx.side.retreatDiscountThisTurn = 2; return null; }, // Leaf：本回合主戰撤退-2
  'A2-150': (ctx, msg) => { // Cyrus：換上對手「身上有傷」的板凳寶可夢當主戰——跟Dark Chase特性同一套換人邏輯
    const idx = ctx.oppSide.bench.findIndex(p => p.uid === msg.target && p.curHp < p.hp);
    if (idx < 0) return '請選擇對手身上有傷的板凳寶可夢';
    const chosen = ctx.oppSide.bench.splice(idx, 1)[0];
    if (ctx.oppSide.active) { ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false; ctx.oppSide.bench.push(ctx.oppSide.active); }
    ctx.oppSide.active = chosen;
    return null;
  },
  'A2a-072': (ctx) => { // Irida：治療己方全部有裝備水能量的寶可夢各40血
    let healed = null, healAmt = 0;
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) {
      if (!p.energy.includes('Water')) continue;
      const before = p.curHp;
      p.curHp = Math.min(p.hp, p.curHp + 40);
      if (p.curHp > before && !healed) { healed = p.uid; healAmt = p.curHp - before; } // 只用第一隻回報飄字動畫，其餘照樣真的回血
    }
    if (healed) { ctx.healUid = healed; ctx.healAmount = healAmt; }
    return null;
  },
  // Barry：本回合指名3隻寶可夢的攻擊消耗的無色能量-2——跟Sticky Membrane/Guard Dog Visage
  // Tool那組「cost+N」相反方向，都是在pocket_attack的pocketCanPayCost呼叫前調整實際cost陣列
  'A2a-074': (ctx) => { ctx.side.namedCostDiscountThisTurn = { names: ['Snorlax', 'Heracross', 'Staraptor'], amount: 2 }; return null; },
  'A3-144': (ctx, msg) => { // Rare Candy：選1隻基礎寶可夢，自動用手牌裡第一張「能跳過第1階直接進化」的Stage2卡
    // 簡化：真實規則玩家可以自選要用哪張Stage2卡，這個引擎的item-target流程只有單一target欄位，
    // 沒有「選基礎寶可夢+另外再選一張手牌」的雙重選擇UI，改成自動挑手牌裡第一張符合條件的
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || target.stage !== 'Basic') return '請選擇一隻基礎寶可夢';
    if (target.boardTurn >= ctx.G.turnNumber) return '這隻寶可夢這回合剛上場，不能使用';
    const handCard = ctx.side.hand.find(c => {
      if (c.stage !== 'Stage2') return false;
      const stage1 = POCKET_CARDS.find(cc => cc.name === c.evolveFrom);
      return stage1 && stage1.evolveFrom === target.name;
    });
    if (!handCard) return '手牌沒有能讓這隻寶可夢跳階進化的Stage 2卡';
    const preservedDamage = (target.hp || 0) - (target.curHp ?? target.hp ?? 0);
    const preservedEnergy = target.energy;
    const preservedUid = target.uid;
    Object.assign(target, structuredClone(POCKET_CARDS_BY_ID[handCard.id]));
    target.uid = preservedUid; target.energy = preservedEnergy;
    target.status = null; target.poisoned = false; target.burned = false; // 2026-08-16應使用者要求：進化時異常狀態要清掉
    target.hp += pocketToolHpBonusAmount(target); // Object.assign後hp已是純base值(不含Tool加成)，直接加回新加成即可，不能算delta
    target.curHp = Math.max(1, (target.hp || 0) - preservedDamage);
    target.boardTurn = ctx.G.turnNumber;
    target._realAbilities = undefined; // 2026-08-08修正：進化後身分變了，清掉舊快取讓特性正確重抓
    // 2026-08-13修正：化石寶可夢(target.stage==='Basic'讓化石本來就是合法目標)用糖果跳階進化
    // 成真正的物種後（例如舊珀→化石翼龍），target.isFossil這個合成欄位是makePocketFossilInstance
    // 塞的、Object.assign只會覆蓋來源物件「有」的欄位，不會清掉來源沒有的舊欄位，導致進化後
    // 還留著isFossil:true，client端「隨時可棄置」的化石專屬按鈕繼續顯示——使用者回報「化石
    // 寶可夢使用糖果進化後怎麼還可以棄置」。
    target.isFossil = false;
    pocketApplyDoubleType(target);
    ctx.side.hand = ctx.side.hand.filter(c => c.uid !== handCard.uid);
    return null;
  },
  'A3-151': (ctx) => { // Guzma：棄置對手全部寶可夢身上裝備的Tool——HP加成要一併收回，KO判定交給pocketBroadcastState裡的pocketResolveAmbientKOs統一處理
    [ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean).forEach(p => pocketDiscardTool(p));
    return null;
  },
  'A3-152': (ctx, msg) => { // Lana：需要己方場上有Araquanid，換上對手任一板凳寶可夢當主戰(不限身上有傷)
    if (![ctx.side.active, ...ctx.side.bench].some(p => p?.name === 'Araquanid')) return '需要場上有Araquanid才能使用';
    const idx = ctx.oppSide.bench.findIndex(p => p.uid === msg.target);
    if (idx < 0) return '請選擇對手板凳上的目標';
    const chosen = ctx.oppSide.bench.splice(idx, 1)[0];
    if (ctx.oppSide.active) { ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false; ctx.oppSide.bench.push(ctx.oppSide.active); }
    ctx.oppSide.active = chosen;
    return null;
  },
  'B1-226': (ctx) => { // Lisia：從牌庫隨機放2隻HP50以下的基礎寶可夢進手牌
    const candidates = ctx.side.deck.map((c, i) => ({ c, i })).filter(({ c }) => c.category === 'Pokemon' && c.stage === 'Basic' && (c.hp || 0) <= 50);
    const picked = pocketShuffle(candidates).slice(0, 2);
    picked.sort((a, b) => b.i - a.i).forEach(({ i }) => { const [card] = ctx.side.deck.splice(i, 1); ctx.side.hand.push(card); });
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'B1a-067': (ctx, msg) => { // Quick-Grow Extract：選1隻己方草屬性寶可夢，牌庫隨機挑1隻能讓牠進化的寶可夢直接進化
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || !(target.types || []).includes('Grass')) return '請選擇一隻草屬性寶可夢';
    if (target.boardTurn >= ctx.G.turnNumber) return '這隻寶可夢這回合剛上場，不能使用';
    const candidates = ctx.side.deck.map((c, i) => ({ c, i })).filter(({ c }) => c.category === 'Pokemon' && c.evolveFrom === target.name);
    if (!candidates.length) return '牌庫沒有能讓這隻寶可夢進化的寶可夢';
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    ctx.side.deck.splice(pick.i, 1);
    const preservedDamage = (target.hp || 0) - (target.curHp ?? target.hp ?? 0);
    const preservedEnergy = target.energy;
    const preservedUid = target.uid;
    Object.assign(target, structuredClone(POCKET_CARDS_BY_ID[pick.c.id]));
    target.uid = preservedUid; target.energy = preservedEnergy;
    target.status = null; target.poisoned = false; target.burned = false; // 2026-08-16應使用者要求：進化時異常狀態要清掉
    target.hp += pocketToolHpBonusAmount(target); // Object.assign後hp已是純base值(不含Tool加成)，直接加回新加成即可，不能算delta
    target.curHp = Math.max(1, (target.hp || 0) - preservedDamage);
    target.boardTurn = ctx.G.turnNumber;
    target._realAbilities = undefined; // 2026-08-08修正：進化後身分變了，清掉舊快取讓特性正確重抓
    pocketApplyDoubleType(target);
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'B1a-068': (ctx) => { // Clemont：從牌庫隨機放2張(Magneton/Heliolisk/Clemont's Backpack)進手牌
    const names = ['Magneton', 'Heliolisk', "Clemont's Backpack"];
    const candidates = ctx.side.deck.map((c, i) => ({ c, i })).filter(({ c }) => names.includes(c.name));
    const picked = pocketShuffle(candidates).slice(0, 2);
    picked.sort((a, b) => b.i - a.i).forEach(({ i }) => { const [card] = ctx.side.deck.splice(i, 1); ctx.side.hand.push(card); });
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'B1a-069': (ctx) => { // Serena：從牌庫隨機放1隻Mega進化ex寶可夢進手牌——卡池目前這類卡的命名慣例都是"Mega X ex"
    const candidates = ctx.side.deck.map((c, i) => ({ c, i })).filter(({ c }) => c.category === 'Pokemon' && c.ex && c.name.startsWith('Mega '));
    if (!candidates.length) return null; // 牌庫沒有符合的卡，卡片正常打出但沒有效果（跟其他"沒有符合目標"的簡化一致）
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    ctx.side.deck.splice(pick.i, 1);
    ctx.side.hand.push(pick.c);
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'B2-145': (ctx) => { // Lucky Ice Pop：治療主戰20血，若真的有回到血就丟硬幣，正面這張卡進手牌而非棄牌堆
    const target = ctx.side.active;
    if (!target) return null;
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 20);
    if (target.curHp > before) {
      ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
      if (pocketFlipCoin(ctx)) ctx.keepInHand = true;
    }
    return null;
  },

  // ── Pokémon Tool（2026-08-07新增系統）──
  // 每隻寶可夢最多裝備1張道具卡，真實規則沒有屬性限制「能不能裝」（任何寶可夢都能裝任何Tool），
  // 只有「效果生不生效」才看屬性/條件——所以pocketAttachTool()本身不檢查類型，類型判斷留給
  // 各張卡自己的一次性效果(HP加成)或後續的被動hook(pocketToolDamageReduction等)。跟能量
  // 附加不同，Tool是Item卡的一種，沒有「每回合限用1次」的限制，可以同一回合裝好幾張到不同
  // 寶可夢身上（跟pocket_play_item共用同一套「item不限次數」規則）。
  // handler回傳null=成功、字串=擋下並顯示錯誤訊息，跟其他TRAINER_EFFECTS一致。
  'A2-147': (ctx, msg) => { // Giant Cape：裝備者+20最大HP（一次性套用，不是持續重算，見pocket-tcg專案記憶的Tool系統設計說明）
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'A2-147', name: 'Giant Cape' };
    const bonus = pocketToolHpBonusAmount(target);
    target.hp += bonus; target.curHp += bonus;
    return null;
  },
  'A3-147': (ctx, msg) => { // Leaf Cape：草屬性裝備者+30最大HP，非草屬性一樣能裝但沒有加成效果
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'A3-147', name: 'Leaf Cape' };
    const bonus = pocketToolHpBonusAmount(target);
    target.hp += bonus; target.curHp += bonus;
    return null;
  },
  'B3a-069': (ctx, msg) => { // Ancient Booster Energy Capsule：準古神獸(Ancient)裝備者+40最大HP
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'B3a-069', name: 'Ancient Booster Energy Capsule' };
    const bonus = pocketToolHpBonusAmount(target);
    target.hp += bonus; target.curHp += bonus;
    return null;
  },
  'B3a-070': (ctx, msg) => { // Future Booster Energy Capsule：近未來(Future)裝備者攻擊+20傷害，效果在pocketToolDamageBonus
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'B3a-070', name: 'Future Booster Energy Capsule' };
    return null;
  },
  'B3b-064': (ctx, msg) => { // Small Balloon：基礎階裝備者撤退-1，效果在pocketToolRetreatDiscount
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'B3b-064', name: 'Small Balloon' };
    return null;
  },
  'B3b-065': (ctx, msg) => { // Elegant Cape：第1階裝備者+30最大HP
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'B3b-065', name: 'Elegant Cape' };
    const bonus = pocketToolHpBonusAmount(target);
    target.hp += bonus; target.curHp += bonus;
    return null;
  },
  'B4-148': (ctx, msg) => { // Deceptive Needle：惡屬性裝備者在主戰位置時，回合結束對對手主戰造成10傷害，效果在checkup
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'B4-148', name: 'Deceptive Needle' };
    return null;
  },
  'B4-149': (ctx, msg) => { // Clear Veil：擋掉對手攻擊對裝備者造成的所有「效果」（傷害正常，不擋），效果在pocket_attack的effectFn呼叫點
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'B4-149', name: 'Clear Veil' };
    return null;
  },
  'B3-148': (ctx, msg) => { // Lucky Egg：裝備者被對手攻擊擊倒時，抽牌到手牌5張，效果在pocket_attack的defenderDied區塊
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'B3-148', name: 'Lucky Egg' };
    return null;
  },
  'FM-005': (ctx, msg) => { // 彩虹能量（Fan Made，2026-08-12新增）：裝備時玩家自選1種屬性，
    // 裝備者視為額外多1個該屬性能量——只影響付費計算，見pocketCanPayCost的FM-005分支。
    // 卡面沒寫at random，屬性一定要玩家自選，跟其他needsChoice/energyType選擇同一套慣例。
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    if (!msg.energyType || !POCKET_ENERGY_TYPE_LIST.includes(msg.energyType)) return '請選擇能量屬性';
    target.tool = { id: 'FM-005', name: 'Rainbow Energy', energyType: msg.energyType };
    return null;
  },
  'FM-006': (ctx, msg) => { // 流星之民的祈禱（Fan Made，2026-08-15新增）：玩家自選2個不同屬性
    // （卡面沒寫at random），從能量區各拿1點分配到場上寶可夢——複用既有energy_distribute的
    // needsChoice流程（energyQueue放這2個屬性），跟Take a {R},{W},{L}那張ATTACK_EFFECTS同一套
    // 機制，差別是屬性由玩家自選而非卡面固定、且來源是支援者卡不是招式。卡面明講「回合結束」，
    // 所以不設noEndTurn，讓pocket_attack_choice收尾時的預設pocketAdvanceTurn接手結束回合。
    const types = Array.isArray(msg?.types) ? [...new Set(msg.types)] : [];
    if (types.length !== 2) return '請選擇兩個不同的能量屬性';
    if (!types.every(t => ctx.side.energyTypes.includes(t))) return '你的能量區沒有這些屬性的能量';
    const pool = [ctx.side.active, ...ctx.side.bench].filter(Boolean);
    if (!pool.length) return '場上沒有寶可夢可以附加能量';
    ctx.needsChoice = { kind: 'energy_distribute', energyQueue: types, eligibleUids: pool.map(p => p.uid), includeActive: true };
    return null;
  },
  ...(() => {
    // 其餘15張Tool卡沒有「附加當下的一次性效果」，純粹是裝備上去、往後由被動hook持續生效——
    // 用同一個簡單handler批次產生，減少重複的find/check/assign樣板碼
    const simpleToolIds = {
      'A2-148': 'Rocky Helmet', 'A2-149': 'Lum Berry', 'A3-146': 'Poison Barb',
      'A3a-065': 'Electrical Cord', 'A3b-067': 'Leftovers', 'A4-153': 'Steel Apron',
      'A4-154': 'Dark Pendant', 'A4-155': 'Rescue Scarf', 'A4a-067': 'Inflatable Boat',
      'B1-218': 'Sitrus Berry', 'B1-219': 'Heavy Helmet', 'B1-220': 'Lucky Mittens',
      'B2-147': 'Protective Poncho', 'B2-148': 'Metal Core Barrier', 'B2a-087': 'Big Air Balloon',
      'A4a-068': 'Memory Light', // 2026-08-08新增：沒有附加當下的一次性效果，實際借招邏輯在pocketEffectiveMoves
    };
    const out = {};
    Object.entries(simpleToolIds).forEach(([id, name]) => {
      out[id] = (ctx, msg) => {
        const target = pocketFindOwn(ctx.side, msg.target);
        if (!target) return '請選擇要裝備的寶可夢';
        if (target.tool) return '這隻寶可夢已經裝備了道具卡';
        target.tool = { id, name };
        return null;
      };
    });
    return out;
  })(),
  // 2026-08-08新增：訓練師卡第三批
  'A2-146': (ctx, msg) => { // Pokémon Communication：手牌選1隻寶可夢跟牌庫隨機1隻互換——
    // 手牌側玩家自選（category==='Pokemon'篩選天然排除掉這張卡自己，因為它是Trainer類）；
    // 牌庫側卡面沒寫玩家自選，維持隨機（跟"Discard a random card..."系列同一種慣例）
    // 2026-08-12修正：牌庫側原本沒有篩category==='Pokemon'，隨機池涵蓋整副牌庫（含訓練師卡）——
    // 卡面文字明講「a random Pokémon in your deck」，換回一張訓練師卡完全不符合卡面規則
    // （使用者回報「只能換到牌堆裡的寶可夢」），牌庫沒有寶可夢卡可換時直接擋掉，不執行互換。
    const idx = ctx.side.hand.findIndex(c => c.uid === msg.target && c.category === 'Pokemon');
    if (idx < 0) return '請選擇手牌裡的一張寶可夢卡';
    const deckPokeIdxs = ctx.side.deck.map((c, i) => c.category === 'Pokemon' ? i : -1).filter(i => i >= 0);
    if (!deckPokeIdxs.length) return '牌庫裡沒有寶可夢卡可以交換';
    const [handPoke] = ctx.side.hand.splice(idx, 1);
    const deckIdx = deckPokeIdxs[Math.floor(Math.random() * deckPokeIdxs.length)];
    const [deckPoke] = ctx.side.deck.splice(deckIdx, 1);
    ctx.side.hand.push(deckPoke);
    ctx.side.deck.push(handPoke);
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'A3-148': (ctx, msg) => { // Acerola：己方受傷的Palossand/Mimikyu，移最多40點傷害給對手主戰
    // （已知邊角互動：這是「移動傷害」不是嚴格定義的「治療」，但跟Heal Block共用同一層
    // 外層snapshot防護，如果對手場上剛好也有Heal Block持有者，這張卡的自我治療半段也會被
    // 一併擋下——兩張稀有卡同時在場的機率很低，判斷不需要為這個交互額外開特例）
    const target = [ctx.side.active, ...ctx.side.bench].find(p => p && p.uid === msg.target && ['Palossand', 'Mimikyu'].includes(p.name));
    if (!target) return '請選擇場上受傷的Palossand或謎擬Q';
    const dmgOnTarget = (target.hp || 0) - target.curHp;
    if (dmgOnTarget <= 0) return '這隻沒有受傷';
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    const moveAmt = Math.min(40, dmgOnTarget);
    target.curHp = Math.min(target.hp, target.curHp + moveAmt);
    ctx.oppSide.active.curHp = Math.max(0, ctx.oppSide.active.curHp - moveAmt);
    return null;
  },
  'A3-150': (ctx, msg) => { // Kiawe：己方的Alolan Marowak/Turtonator附加2點火能量，這回合結束
    const target = [ctx.side.active, ...ctx.side.bench].find(p => p && p.uid === msg.target && ['Alolan Marowak', 'Turtonator'].includes(p.name));
    if (!target) return '請選擇場上的阿羅拉喪面犬或圖圖犬';
    target.energy.push('Fire', 'Fire');
    ctx.endTurnAfter = true;
    return null;
  },
  'A3b-066': (ctx, msg) => { // Eevee Bag：2選1，msg.choice決定要哪一個效果——client端讓玩家
    // 在卡片詳情面板直接看到2顆按鈕分別送出，不用另外開新的選擇modal
    if (msg.choice === 'boost') { ctx.side.eeveeBoostThisTurn = true; return null; }
    if (msg.choice === 'heal') {
      for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) {
        if (p.evolveFrom === 'Eevee') p.curHp = Math.min(p.hp, p.curHp + 20);
      }
      return null;
    }
    return '請選擇一個效果';
  },
  'B1-222': (ctx) => { // Hala：設一個「對手下回合」的保護時效旗標，實際KO-prevention判定在
    // pocket_attack的死亡判定區塊（跟Guts共用同一種「HP變10」機制，見那裡的註解）
    ctx.side.halaProtectUntilTurn = ctx.G.turnNumber + 1;
    return null;
  },
  'B1-223': (ctx) => { // May：先隨機放2隻寶可夢進手牌（卡面這半段沒寫玩家自選），再暫停等玩家
    // 選2張手牌洗回牌庫——這半段玩家看得到剛抽到什麼才決定洗哪2張，需要真正暫停等選擇
    // （跟pocket_evolve的ctx.needsChoice同一套convention，這是第一次用在訓練師卡）
    const idxs = ctx.side.deck.map((c, i) => c.category === 'Pokemon' ? i : -1).filter(i => i >= 0);
    const picked = [];
    for (let i = 0; i < 2 && idxs.length; i++) {
      const j = Math.floor(Math.random() * idxs.length);
      const deckIdx = idxs.splice(j, 1)[0];
      picked.push(deckIdx);
    }
    picked.sort((a, b) => b - a); // 由大到小刪除，避免刪除時index位移影響後面的索引
    for (const i of picked) ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]);
    if (picked.length) {
      const eligible = ctx.side.hand.filter(c => c.category === 'Pokemon').map(c => c.uid);
      ctx.needsChoice = { kind: 'pick_hand_multi', pool: 'ownHand', eligibleUids: eligible, remaining: picked.length, noEndTurn: true };
    }
    return null;
  },
  // 2026-08-08再接續：訓練師卡第四批（May之後才確認ctx.needsChoice可以延伸到訓練師卡流程，
  // 回頭撿之前判斷「需要揭露/選擇」而跳過的卡）
  'A4-158': (ctx) => { // Silver：揭露對手手牌，選1張支援者洗回對手牌庫——直接複用既有的
    // pool:'oppHand'/action:'shuffleIntoDeck'機制（原本只在ATTACK_EFFECTS用過，這是第一次
    // 從訓練師卡流程觸發）
    const eligible = ctx.oppSide.hand.filter(c => c.category === 'Trainer' && c.trainerType === 'Supporter');
    ctx.peekHand = ctx.oppSide.hand;
    if (eligible.length) ctx.needsChoice = { kind: 'pick_target', pool: 'oppHand', eligibleUids: eligible.map(c => c.uid), action: 'shuffleIntoDeck', noEndTurn: true };
    return null;
  },
  'B1-217': (ctx) => { // Flame Patch：從自己棄牌堆拿1火能量附給主戰——直接複用既有的
    // pocketTakeEnergyFromDiscard（Combust特性已經在用同一個函式）
    if (!ctx.side.active) return '沒有主戰寶可夢';
    if (!pocketTakeEnergyFromDiscard(ctx.side, 'Fire')) return '棄牌堆沒有火屬性能量可以拿';
    ctx.side.active.energy.push('Fire');
    return null;
  },
  'B1-213': (ctx) => { // Prank Spinner：雙方手牌合併成一個池子，隨機抽1張洗回牌主自己的牌庫
    // （卡面沒有"choose"字樣，是真的隨機，不是玩家選）
    const pool = [...ctx.side.hand.map(c => ({ c, owner: ctx.side })), ...ctx.oppSide.hand.map(c => ({ c, owner: ctx.oppSide }))];
    if (!pool.length) return null;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    const idx = picked.owner.hand.indexOf(picked.c);
    picked.owner.hand.splice(idx, 1);
    picked.owner.deck.push(picked.c);
    picked.owner.deck = pocketShuffle(picked.owner.deck);
    return null;
  },
  // 2026-08-08再接續：Ultra Beast系列3張（Beast Wall/Beastite/Lusamine），標籤機制見
  // pocketIsUltraBeast——用官方11隻真名比對，不需要卡池資料本身有分類欄位
  'A3a-063': (ctx) => { // Beast Wall：對手分數必須是0才能用；設side層級的時限減傷，實際判定在mainDamage計算式
    if ((ctx.oppSide.points || 0) !== 0) return '對手已經得分過，無法使用這張卡';
    ctx.side.ultraBeastShieldUntilTurn = ctx.G.turnNumber + 1;
    ctx.side.ultraBeastShieldAmount = 20;
    return null;
  },
  'A3a-066': (ctx, msg) => { // Beastite：只能裝備在Ultra Beast身上（跟Leaf Cape那種「誰都能裝、
    // 只是條件不符沒加成」不同，這張卡面本身定義了裝備對象，非UB直接拒絕）
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要裝備的寶可夢';
    if (!pocketIsUltraBeast(target)) return '這張卡只能裝備在Ultra Beast身上';
    if (target.tool) return '這隻寶可夢已經裝備了道具卡';
    target.tool = { id: 'A3a-066', name: 'Beastite' };
    return null;
  },
  'A3a-069': (ctx, msg) => { // Lusamine：對手分數必須至少1才能用；選1隻自己的Ultra Beast，從棄牌堆隨機拿2點能量附上去
    if ((ctx.oppSide.points || 0) < 1) return '對手還沒有得分，無法使用這張卡';
    const target = [ctx.side.active, ...ctx.side.bench].find(p => p && p.uid === msg.target && pocketIsUltraBeast(p));
    if (!target) return '請選擇場上的一隻Ultra Beast';
    const pool = [];
    ctx.side.discard.forEach(c => (c.energy || []).forEach(e => pool.push(e)));
    for (let i = 0; i < 2 && pool.length; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      const [e] = pool.splice(idx, 1);
      target.energy.push(e);
      // 從棄牌堆卡片實際扣掉這點能量，避免同一點能量被重複拿取（跟pocketTakeEnergyFromDiscard同一種一致性考量）
      const owner = ctx.side.discard.find(c => (c.energy || []).includes(e));
      if (owner) owner.energy.splice(owner.energy.indexOf(e), 1);
    }
    return null;
  },
  // Will（2026-08-08新增）：只保證「下一批擲硬幣」的第一枚正面，不是全部——設定forceHeadsForRole
  // 讓pocketFlipCoin下次被呼叫時（只要role對得上）強制回傳true，用一次就被pocketFlipCoin
  // 自己內部的forceHeadsUsed清掉，天然只影響「第一枚」不影響同一批的後續硬幣
  'A4-156': (ctx) => {
    ctx.G.forceHeadsForRole = ctx.role;
    ctx.G.forceHeadsUsed = false;
    return null;
  },
  // Penny（2026-08-08新增）：跟Portrait同一種「借用效果」機制，差別是來源池是對手牌庫（不是
  // 手牌）、排除自己同名（不能借另一張Penny，避免自我遞迴/無窮借用鏈）——「look at...and
  // shuffle it back」代表只是偷看+洗回去，牌庫組成沒有真的改變，不用動ctx.oppSide.deck
  'A3b-069': (ctx) => {
    const eligible = ctx.oppSide.deck.filter(c => c.category === 'Trainer' && c.trainerType === 'Supporter' && c.name !== 'Penny');
    if (!eligible.length) return null;
    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    const handler = TRAINER_EFFECTS[picked.effectId || picked.id];
    if (handler) handler(ctx, {});
    return null;
  },

  /* ── 2026-08-08新增：B2b~B4系列訓練師卡第一批 ── */
  'B2b-065': (ctx) => { // Nasty Notice：對手棄牌到剩4張
    const excess = ctx.oppSide.hand.length - 4;
    for (let i = 0; i < excess; i++) {
      const idx = Math.floor(Math.random() * ctx.oppSide.hand.length);
      ctx.oppSide.discard.push(ctx.oppSide.hand.splice(idx, 1)[0]);
    }
    return null;
  },
  'B2b-066': (ctx, msg) => { // Maintenance：手牌選2張洗回牌庫，抽1張——2026-08-13應使用者要求改成
    // 玩家自選要洗掉哪2張，不能用Math.random()（pocket-tcg skill的鐵律，已經被糾正過好幾次）。
    // 跟May（B1-223）同一套pick_hand_multi convention。用msg.handUid排除掉這張卡自己——
    // 這個handler執行的當下，Maintenance這張卡本身還在ctx.side.hand裡（pocket_play_supporter
    // 是等handler跑完才把打出的卡從手牌splice掉），不排除的話玩家可能選到還沒真正離手的自己。
    const eligible = ctx.side.hand.filter(c => c.uid !== msg.handUid).map(c => c.uid);
    if (eligible.length < 2) return '手牌不足2張，無法使用';
    ctx.needsChoice = { kind: 'pick_hand_multi', pool: 'ownHand', eligibleUids: eligible, remaining: 2, noEndTurn: true, drawAfter: 1 };
    return null;
  },
  // Iris：本回合設一個旗標，KO判定那邊（見pocket_attack的Haxorus KO區塊）檢查這個旗標決定要不要多給1分
  'B2b-067': (ctx) => { ctx.side.irisBonusThisTurn = true; return null; },
  'B2b-068': (ctx) => { // Calem：雙方場上每隻Mega Evolution ex各抽1張（名字開頭"Mega "且ex）
    const count = ['p1', 'p2'].reduce((sum, r) => sum + [ctx.G[r].active, ...ctx.G[r].bench].filter(p => p && p.ex && p.name.startsWith('Mega ')).length, 0);
    for (let i = 0; i < count && ctx.side.deck.length; i++) ctx.side.hand.push(ctx.side.deck.shift());
    return null;
  },
  'B2b-069': (ctx) => { ctx.G.activeStadium = { id: 'B2b-069', name: 'Hiking Trail' }; return null; },
  'B3-147': (ctx, msg) => { // Field Blower：棄掉任一寶可夢身上的道具卡，或棄掉場地卡（msg.target='stadium'代表選場地）
    if (msg.target === 'stadium') {
      if (!ctx.G.activeStadium) return '場上沒有場地卡';
      ctx.G.activeStadium = null;
      return null;
    }
    const pool = [ctx.side.active, ...ctx.side.bench, ctx.oppSide.active, ...ctx.oppSide.bench].filter(Boolean);
    const target = pool.find(p => p.uid === msg.target);
    if (!target) return '請選擇要棄掉道具卡的寶可夢，或選擇棄掉場地卡';
    if (!target.tool) return '這隻寶可夢沒有裝備道具卡';
    pocketDiscardTool(target); // HP加成收回＋KO判定交給pocketResolveAmbientKOs（見pocketDiscardTool的說明）
    return null;
  },
  'B3-149': (ctx) => { ctx.side.typeBoostThisTurn = { type: 'Fighting', amount: 30, exOnly: true }; return null; }, // Korrina
  'B3-150': (ctx) => { // Cabbie：牌庫隨機1張場地卡進手牌
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Trainer' && c.trainerType === 'Stadium') ? i : -1).filter(i => i >= 0);
    if (!idxs.length) return '牌庫沒有場地卡';
    const idx = idxs[Math.floor(Math.random() * idxs.length)];
    ctx.side.hand.push(ctx.side.deck.splice(idx, 1)[0]);
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  // Cheren：對手下回合，己方場上指名的Watchog/Stoutland受到ex攻擊的傷害-100——新增
  // defShieldUntilTurn/defShieldAmount/defShieldNames/defShieldExOnly，跟dmgDebuffUntilTurn
  // 方向相反（那個是「持有者自己出手變弱」，這個是「持有者被打時變硬」），掛在side層級
  // 因為要同時保護2種不同名字的寶可夢，不是單一defender
  'B3-151': (ctx) => {
    ctx.side.defShieldUntilTurn = ctx.G.turnNumber + 1;
    ctx.side.defShieldAmount = 100;
    ctx.side.defShieldNames = ['Watchog', 'Stoutland'];
    ctx.side.defShieldExOnly = true;
    return null;
  },
  'B3-152': (ctx, msg) => { // Parasol Lady：己方非ex的水屬性寶可夢(不限主戰/板凳)放回手牌
    const pool = [ctx.side.active, ...ctx.side.bench].filter(p => p && !p.ex && (p.types || []).includes('Water'));
    const target = pool.find(p => p.uid === msg.target);
    if (!target) return '請選擇己方非ex的水屬性寶可夢';
    const wasActive = ctx.side.active === target;
    if (wasActive) ctx.side.active = null; else ctx.side.bench = ctx.side.bench.filter(p => p.uid !== target.uid);
    // 2026-08-11修正：放回手牌要用makePocketInstance建立一張全新的乾淨卡片實例（含新uid），
    // 不能直接structuredClone原始卡池資料——那份資料沒有uid，抽到手牌會完全點不到（同一類bug
    // 出現在Professor Turo等好幾張卡，見那裡的完整說明）
    ctx.side.hand.push(makePocketInstance(target.id));
    // 選走的如果剛好是主戰，不能放著主戰位置空著沒人——跟Sabrina/Drive Off同一套強制換人流程
    if (wasActive) pocketEnterForcedSwitch(ctx.G, ctx.role, 'noEndTurn');
    return null;
  },
  'B3-153': (ctx) => { ctx.G.activeStadium = { id: 'B3-153', name: 'Fragrant Forest' }; return null; },
  'B3-154': (ctx) => { ctx.G.activeStadium = { id: 'B3-154', name: 'Arena of Antiquity' }; return null; },
  'B3-155': (ctx) => { ctx.G.activeStadium = { id: 'B3-155', name: 'Bounded Field' }; return null; },
  'B3a-071': (ctx) => { // Juliana：牌庫隨機1張Stage2寶可夢進手牌
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Pokemon' && c.stage === 'Stage2') ? i : -1).filter(i => i >= 0);
    if (!idxs.length) return '牌庫沒有Stage 2寶可夢';
    const idx = idxs[Math.floor(Math.random() * idxs.length)];
    ctx.side.hand.push(ctx.side.deck.splice(idx, 1)[0]);
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'B3a-072': (ctx) => { // Professor Sada：從棄牌堆（棄置寶可夢身上殘留的能量）拿3種不同屬性能量附給自己的準古（Ancient）主戰
    if (!ctx.side.active || !ANCIENT_POKEMON_NAMES.has(ctx.side.active.name)) return '主戰必須是準古神獸(Ancient Pokémon)';
    const taken = [];
    for (const type of POCKET_ENERGY_TYPE_LIST) {
      if (taken.length >= 3) break;
      if (pocketTakeEnergyFromDiscard(ctx.side, type)) taken.push(type);
    }
    if (!taken.length) return '棄牌堆沒有能量可以拿';
    ctx.side.active.energy.push(...taken);
    return null;
  },
  'B3a-073': (ctx, msg) => { // Professor Turo：己方場上（不限主戰/板凳）1隻近未來（Future）寶可夢洗回牌庫
    const pool = [ctx.side.active, ...ctx.side.bench].filter(p => p && FUTURE_POKEMON_NAMES.has(p.name));
    const target = pool.find(p => p.uid === msg.target);
    if (!target) return '請選擇己方場上的近未來寶可夢(Future Pokémon)';
    const wasActive = ctx.side.active === target;
    if (wasActive) ctx.side.active = null; else ctx.side.bench = ctx.side.bench.filter(p => p.uid !== target.uid);
    // 2026-08-11修正：改用makePocketInstance建立全新卡片實例（含新uid）——原本用structuredClone
    // 直接塞回牌庫，缺少uid導致之後重新抽到手牌時完全點不到（使用者回報「用Professor Turo將
    // 密勒頓洗回牌組後，重新抽到會無法點擊」）
    ctx.side.deck = pocketShuffle([...ctx.side.deck, makePocketInstance(target.id)]);
    // 選走的如果剛好是主戰，不能放著主戰位置空著沒人——跟Parasol Lady/Sabrina/Drive Off同一套強制換人流程
    if (wasActive) pocketEnterForcedSwitch(ctx.G, ctx.role, 'noEndTurn');
    return null;
  },
  // Area Zero：打出來只負責蓋場地卡，「每回合各自可以用一次」的主動效果跟Mesagoza/Fragrant
  // Forest/Kid's Room/Rainbow Cave一樣，走獨立的'pocket_use_stadium'訊息（見那裡）
  'B3a-074': (ctx) => { ctx.G.activeStadium = { id: 'B3a-074', name: 'Area Zero' }; return null; },
  'B3b-066': (ctx) => { // Elesa：雙方場上全部寶可夢的道具卡都放回持有者手牌
    for (const r of ['p1', 'p2']) {
      for (const p of [ctx.G[r].active, ...ctx.G[r].bench]) {
        if (p?.tool) { ctx.G[r].hand.push(makePocketInstance(p.tool.id)); p.tool = null; } // 2026-08-11修正：補uid，理由同上
      }
    }
    return null;
  },
  'B3b-067': (ctx) => { // Puppy-Loving Girl：看牌庫頂4張，有「Puppy Pile」招式的寶可夢全部進手牌
    const top = ctx.side.deck.splice(0, Math.min(4, ctx.side.deck.length));
    const picked = top.filter(c => c.attacks?.some(a => a.name === 'Puppy Pile'));
    const rest = top.filter(c => !picked.includes(c));
    ctx.side.hand.push(...picked);
    ctx.side.deck = pocketShuffle([...ctx.side.deck, ...rest]);
    return null;
  },
  'B3b-068': (ctx, msg) => { // Wallace：己方場上HP上限≤50的水屬性寶可夢，從牌庫隨機拿1張進化牠
    const pool = [ctx.side.active, ...ctx.side.bench].filter(p => p && (p.types || []).includes('Water') && p.hp <= 50);
    const target = pool.find(p => p.uid === msg.target);
    if (!target) return '請選擇己方HP上限50以下的水屬性寶可夢';
    const candidates = ctx.side.deck.map((c, i) => ({ c, i })).filter(({ c }) => c.category === 'Pokemon' && (c.types || []).includes('Water') && c.evolveFrom === target.name);
    if (!candidates.length) return '牌庫沒有能讓這隻進化的水屬性寶可夢';
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    ctx.side.deck.splice(pick.i, 1);
    const preservedDamage = (target.hp || 0) - (target.curHp ?? target.hp ?? 0);
    const preservedEnergy = target.energy; const preservedUid = target.uid;
    Object.assign(target, structuredClone(POCKET_CARDS_BY_ID[pick.c.id]));
    target.uid = preservedUid; target.energy = preservedEnergy;
    target.status = null; target.poisoned = false; target.burned = false; // 2026-08-16應使用者要求：進化時異常狀態要清掉
    target.hp += pocketToolHpBonusAmount(target); // Object.assign後hp已是純base值(不含Tool加成)，直接加回新加成即可，不能算delta
    target.curHp = Math.max(1, (target.hp || 0) - preservedDamage);
    target.boardTurn = ctx.G.turnNumber;
    target._realAbilities = undefined;
    pocketApplyDoubleType(target);
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'B3b-069': (ctx) => { ctx.G.activeStadium = { id: 'B3b-069', name: "Kid's Room" }; return null; },
  'B4-145': (ctx) => { // Order Pad：擲硬幣，正面隨機1張道具卡進手牌
    if (!pocketFlipCoin(ctx)) return null;
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Trainer' && c.trainerType === 'Item') ? i : -1).filter(i => i >= 0);
    if (!idxs.length) return null;
    const idx = idxs[Math.floor(Math.random() * idxs.length)];
    ctx.side.hand.push(ctx.side.deck.splice(idx, 1)[0]);
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'B4-150': (ctx, msg) => { // Psychic：主戰必須帶有「Psychic」這招，選對手板凳1隻，隨機移1點能量到對手主戰
    if (!ctx.side.active?.attacks?.some(a => a.name === 'Psychic')) return '主戰必須擁有「Psychic」招式才能使用';
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    const target = ctx.oppSide.bench.find(p => p.uid === msg.target);
    if (!target) return '請選擇對手板凳上的目標';
    if (!target.energy.length) return '這隻身上沒有能量可以移動';
    const idx = Math.floor(Math.random() * target.energy.length);
    const [e] = target.energy.splice(idx, 1);
    ctx.oppSide.active.energy.push(e);
    return null;
  },
  'B4-151': (ctx) => { ctx.side.dracoMeteorExtraThisTurn = true; return null; }, // Drayden
  'B4-152': (ctx, msg) => { // Skyla：主戰必須是Stage1，跟板凳交換
    if (!ctx.side.active || ctx.side.active.stage !== 'Stage1') return '主戰必須是第1階寶可夢';
    const idx = ctx.side.bench.findIndex(p => p.uid === msg.target);
    if (idx < 0) return '請選擇板凳上要換上場的寶可夢';
    const chosen = ctx.side.bench.splice(idx, 1)[0];
    ctx.side.active.status = null; ctx.side.active.poisoned = false; ctx.side.active.burned = false;
    ctx.side.bench.push(ctx.side.active);
    ctx.side.active = chosen;
    return null;
  },
  'B4-153': (ctx, msg) => { // Wally：能量區拿1無色能量附給己方1隻Stage2——2026-08-16應使用者
    // 回報修正：卡面文字跟其他「Take a {X} Energy from your Energy Zone and attach it to...」
    // 的招式/特性（例如Volt Charge）是同一種寫法，應該是憑空額外貼1個無色能量，不該綁定/
    // 消耗side.pendingEnergy這個「本回合正常手動附加能量」的資源——原本錯誤地要求pendingEnergy
    // 存在才能用、用完還把pendingEnergy清空，等於逼玩家二選一，卡面完全沒有這個限制
    const target = [ctx.side.active, ...ctx.side.bench].find(p => p && p.uid === msg.target && p.stage === 'Stage2');
    if (!target) return '請選擇己方場上的Stage 2寶可夢';
    target.energy.push('Colorless');
    return null;
  },
  'B4-154': (ctx) => { ctx.G.activeStadium = { id: 'B4-154', name: 'Soothing Shore' }; return null; },
  'B4-155': (ctx) => { ctx.G.activeStadium = { id: 'B4-155', name: 'Rainbow Cave' }; return null; },
};

// ── Pokémon Tool 被動效果 hook（跟pocketPassive*系列的特性被動是同一套設計理念，只是
//    依 poke.tool?.id 判斷而不是 poke.abilities?.[0]?.name）──
// 固定減傷：Steel Apron(-10，鋼屬性裝備者)、Heavy Helmet(-20，撤退成本≥3的裝備者)、
// Metal Core Barrier(-50，鋼屬性裝備者)。跟pocketPassiveDamageReduction同樣的「defender
// 恆等於defenderSide.active」前提（招式固定打對方主戰），呼叫端把兩者加總即可。
function pocketToolDamageReduction(defender) {
  const toolId = defender.tool?.id;
  if (toolId === 'A4-153' && (defender.types || []).includes('Metal')) return 10;
  if (toolId === 'B1-219' && (defender.retreat || 0) >= 3) return 20;
  if (toolId === 'B2-148' && (defender.types || []).includes('Metal')) return 50;
  return 0;
}
// Ultra Beast標籤（2026-08-08新增）：卡池資料沒有這個分類欄位，改用官方11隻Ultra Beast的
// 真名清單比對（跟Zangoose/Falinks等其他「用真名判斷」的card是同一種慣例）——" ex"字尾要
// 先去掉再比對，因為ex版本是不同的card.name字串
const ULTRA_BEAST_NAMES = new Set(['Nihilego', 'Buzzwole', 'Pheromosa', 'Xurkitree', 'Celesteela', 'Kartana', 'Guzzlord', 'Poipole', 'Naganadel', 'Stakataka', 'Blacephalon']);
function pocketIsUltraBeast(poke) {
  return ULTRA_BEAST_NAMES.has((poke?.name || '').replace(/ ex$/, ''));
}
// Beastite（2026-08-08新增Tool，只能裝備在Ultra Beast身上，見TRAINER_EFFECTS的attach-time
// 限制）：裝備者攻擊時，依「自己這一方目前的分數」每點+10傷害給對手主戰
function pocketToolDamageBonus(attacker, side) {
  if (attacker.tool?.id === 'A3a-066') return (side.points || 0) * 10;
  // Future Booster Energy Capsule（2026-08-08新增）：跟Beastite同一種「Tool給裝備者攻擊加傷」
  // 寫法，限定裝備者是近未來(Future)寶可夢
  if (attacker.tool?.id === 'B3a-070' && FUTURE_POKEMON_NAMES.has(attacker.name)) return 20;
  return 0;
}
// 被攻擊打中時觸發（跟pocketPassiveOnHit同一套時機，mainDamage>0就觸發，不需要defender死亡）：
// Rocky Helmet反傷20、Poison Barb讓攻擊者中毒、Dark Pendant讓對方公開手牌隨機1張洗回牌庫。
// 回傳{counterDamage, poisonAttacker, revealShuffleOpp}供呼叫端套用。
function pocketToolOnHit(defender) {
  const toolId = defender.tool?.id;
  const result = { counterDamage: 0, poisonAttacker: false, revealShuffleOpp: false };
  if (toolId === 'A2-148') result.counterDamage = 20;
  if (toolId === 'A3-146') result.poisonAttacker = true;
  if (toolId === 'A4-154') result.revealShuffleOpp = true;
  return result;
}
// 撤退折扣：Inflatable Boat(-1，水屬性裝備者)、Big Air Balloon(免費，Stage2裝備者)——
// 跟pocketPassiveFreeRetreat/pocketPassiveBenchRetreatDiscount同一組hook點，回傳
// {free, discount}供呼叫端套用（free優先於discount，兩者不會同時生效在同一張卡上）
function pocketToolRetreatDiscount(poke) {
  const toolId = poke.tool?.id;
  if (toolId === 'B2a-087' && poke.stage === 'Stage2') return { free: true, discount: 0 };
  if (toolId === 'A4a-067' && (poke.types || []).includes('Water')) return { free: false, discount: 1 };
  if (toolId === 'B3b-064' && poke.stage === 'Basic') return { free: false, discount: 1 }; // Small Balloon
  return { free: false, discount: 0 };
}
// 板凳傷害免疫：Protective Poncho/Shell Shield，裝備者(或特性持有者)在板凳上時完全不受
// 對手招式/特性造成的傷害——集中成一個判斷式，snapshot/enforce流程跟KO觸發型特性(Final
// Scream)兩種call site共用，避免同一條規則散落兩份、其中一份忘了更新
function pocketBenchDamageImmune(poke, isOnBench) {
  return isOnBench && (poke.tool?.id === 'B2-147' || poke.abilities?.[0]?.name === 'Shell Shield');
}

// ── 完全免疫異常狀態（2026-08-07新增）：Fabled Luster/Insomnia(僅睡眠)/Flower Shield/
//    Soothing Wind 4個特性 + Steel Apron 1張Tool。這個卡池裡「直接指定status='x'」的
//    handler散布在ATTACK_EFFECTS/TRAINER_EFFECTS/ABILITY_EFFECTS三個表裡數十處，逐一加
//    判斷風險高也難維護——改成在三個表「各自唯一的呼叫點」前後各包一層快照比對：呼叫前
//    記錄雙方在場寶可夢的status，呼叫後如果變了且新狀態的目標剛好免疫，直接復原成呼叫前
//    的值。這樣完全不用碰任何一個既有/未來新增的handler內部邏輯。
// 2026-08-13新增：中毒/燒傷改成獨立布林欄位，睡眠/麻痺/混亂仍留在.status——凡是「用字串代表
// 隨機選其中一種異常狀態」的效果（例如下面兩處"1 Special Condition from among..."的隨機選卡文字）
// 都要透過這兩個小helper讀寫，不要直接手寫if/else判斷5種字串該對應到哪個欄位
function pocketSetCondition(poke, effect) {
  if (effect === 'poisoned') poke.poisoned = true;
  else if (effect === 'burned') poke.burned = true;
  else poke.status = effect; // asleep/paralyzed/confused
}
function pocketHasCondition(poke, effect) {
  if (!poke) return false;
  if (effect === 'poisoned') return !!poke.poisoned;
  if (effect === 'burned') return !!poke.burned;
  return poke.status === effect;
}
// "remove A RANDOM Special Condition"卡面文字專用（Big Malasada/Happiness Supplement共用）——
// 列出這隻寶可夢目前實際存在的每一種狀態（最多3種：status欄位1種+中毒+灼傷），真的隨機選1個解除，
// 沒有任何狀態時回傳false（呼叫端可以據此決定要不要顯示「沒有異常狀態」的錯誤訊息）
function pocketRemoveRandomCondition(poke) {
  if (!poke) return false;
  const present = [];
  if (poke.status) present.push(poke.status);
  if (poke.poisoned) present.push('poisoned');
  if (poke.burned) present.push('burned');
  if (!present.length) return false;
  const pick = present[Math.floor(Math.random() * present.length)];
  if (pick === 'poisoned') poke.poisoned = false;
  else if (pick === 'burned') poke.burned = false;
  else poke.status = null;
  return true;
}
// Flower Shield/Soothing Wind的「隊伍型免疫」判定資格，抽成獨立函式——pocketIsStatusImmune
// (擋新狀態)跟下面新增的pocketApplySoothingCure(主動治癒既有狀態)都要用同一套「side上任一隻
// 持有這個特性」+「這隻自己身上有符合條件的能量」判斷，避免兩處各自維護一份容易漂移
function pocketQualifiesForTeamCureShield(poke, side) {
  const teamAbilities = [side.active, ...side.bench].filter(Boolean).map(p => p.abilities?.[0]?.name);
  if (teamAbilities.includes('Flower Shield') && (poke.energy || []).includes('Psychic')) return true;
  if (teamAbilities.includes('Soothing Wind') && (poke.energy || []).length > 0) return true;
  return false;
}
function pocketIsStatusImmune(poke, side, effect) {
  const ownAbility = poke.abilities?.[0]?.name;
  if (ownAbility === 'Fabled Luster') return true;
  if (ownAbility === 'Insomnia' && effect === 'asleep') return true;
  if (poke.tool?.id === 'A4-153' && (poke.types || []).includes('Metal')) return true; // Steel Apron
  // Flower Shield/Soothing Wind：隊伍型被動——不是「這隻自己有沒有這個特性」，是「side上
  // 任一隻持有這個特性」+「這隻自己身上有符合條件的能量」，持有者自己也算在保護範圍內
  if (pocketQualifiesForTeamCureShield(poke, side)) return true;
  return false;
}
// 2026-08-13新增：Flower Shield/Soothing Wind卡面文字其實有兩段——「不會受到任何特殊狀態影響」
// （免疫，上面pocketIsStatusImmune已經擋了）跟「從所有特殊狀態中恢復」（主動治癒），原本只做了
// 免疫那一半，治癒那一半完全沒實作，玩家回報「特性沒有成功發動」正是這個治癒部分。掛在「新符合
// 資格」最可能發生的兩個時機：附加能量給某隻寶可夢後（pocket_attach_energy）、進化完成後
// （pocket_evolve，可能剛好進化成這隻持有者），外加每次checkup當一層防呆保底。
function pocketApplySoothingCure(side) {
  [side.active, ...side.bench].filter(Boolean).forEach(p => {
    if ((p.status != null || p.poisoned || p.burned) && pocketQualifiesForTeamCureShield(p, side)) {
      p.status = null; p.poisoned = false; p.burned = false;
    }
  });
}
function pocketSnapshotStatus(side) {
  return new Map([side.active, ...side.bench].filter(Boolean).map(p => [p.uid, { status: p.status, poisoned: !!p.poisoned, burned: !!p.burned }]));
}
function pocketEnforceStatusImmunity(side, snapshot) {
  [side.active, ...side.bench].filter(Boolean).forEach(p => {
    const prev = snapshot.get(p.uid);
    if (!prev) return;
    if (p.status !== prev.status && p.status != null && pocketIsStatusImmune(p, side, p.status)) {
      p.status = prev.status ?? null;
    }
    if (p.poisoned && !prev.poisoned && pocketIsStatusImmune(p, side, 'poisoned')) p.poisoned = false;
    if (p.burned && !prev.burned && pocketIsStatusImmune(p, side, 'burned')) p.burned = false;
  });
}
// Protective Poncho（2026-08-07新增Tool）：裝備者在板凳上時，完全不受「對手」招式/特性造成
// 的傷害——跟status immunity同一招「呼叫前後snapshot比對、免疫就復原」，但只套用在oppSide
// 的板凳（= 呼叫端的「對手」板凳），不查side自己的板凳，避免不小心連自傷效果都一起擋掉
// （3個呼叫點裡side永遠是「正在行動的一方」、oppSide永遠是「對方」，方向不會搞混）
function pocketSnapshotBenchHp(side) {
  return new Map(side.bench.map(p => [p.uid, p.curHp]));
}
function pocketEnforceBenchImmunity(side, snapshot) {
  side.bench.forEach(p => {
    if (snapshot.has(p.uid) && p.curHp < snapshot.get(p.uid) && pocketBenchDamageImmune(p, true)) {
      p.curHp = snapshot.get(p.uid);
    }
  });
}
// Crystal Body（2026-08-07新增）：「Prevent all effects of attacks used by your opponent's
// Pokémon done to this Pokémon」——傷害本身不算在內（真實規則的effect不含damage），只擋
// 招式效果對defender造成的非傷害副作用。跟status immunity同一招snapshot-before/compare-after，
// 但這裡額外多記幾個「效果handler常寫進defender身上」的欄位（cantAttack/dmgDebuff/
// attackFlipLock/energy），呼叫端只在effectFn呼叫前後這一個點包一層，不用碰任何handler內部
function pocketSnapshotDefenderEffect(defender) {
  return {
    cantAttackUntilTurn: defender.cantAttackUntilTurn,
    dmgDebuffUntilTurn: defender.dmgDebuffUntilTurn,
    dmgDebuffAmount: defender.dmgDebuffAmount,
    attackFlipLockUntilTurn: defender.attackFlipLockUntilTurn,
    energy: [...defender.energy],
  };
}
function pocketEnforceDefenderEffectImmunity(defender, snapshot) {
  if (defender.abilities?.[0]?.name !== 'Crystal Body') return;
  defender.cantAttackUntilTurn = snapshot.cantAttackUntilTurn;
  defender.dmgDebuffUntilTurn = snapshot.dmgDebuffUntilTurn;
  defender.dmgDebuffAmount = snapshot.dmgDebuffAmount;
  defender.attackFlipLockUntilTurn = snapshot.attackFlipLockUntilTurn;
  defender.energy = snapshot.energy;
}
// Heal Block（2026-08-07新增）：「Pokémon (both yours and your opponent's) can't be healed」——
// 跟Crystal Body等「持有者自己被保護」不同方向，這是「持有者在場上（不限主戰/板凳/哪一方）
// 時，雙方所有寶可夢的治療全部失效」的全域鎖，用同一套snapshot-before/compare-after招數，
// 只是這次snapshot範圍是雙方全場（不是單一defender/單一side的板凳），呼叫端在每個「可能
// 觸發治療」的handler呼叫點包一層即可，不用逐一改治療handler本身
function pocketHasHealBlock(G) {
  return ['p1', 'p2'].some(r => [G[r].active, ...G[r].bench].some(p => p?.abilities?.[0]?.name === 'Heal Block'));
}
function pocketSnapshotAllHp(G) {
  const m = new Map();
  for (const r of ['p1', 'p2']) for (const p of [G[r].active, ...G[r].bench]) if (p) m.set(p.uid, p.curHp);
  return m;
}
function pocketEnforceHealBlock(G, snapshot) {
  if (!pocketHasHealBlock(G)) return;
  for (const r of ['p1', 'p2']) for (const p of [G[r].active, ...G[r].bench]) {
    if (p && snapshot.has(p.uid) && p.curHp > snapshot.get(p.uid)) p.curHp = snapshot.get(p.uid);
  }
}

/* ── 特性(ability)：每回合限用1次的主動觸發型（key用ability.name）。
   被動常駐型（Gengar ex「詭異束縛」擋支援者卡）不在這裡，是在打出支援者卡時直接檢查對方主戰是不是Gengar ex。 */
const ABILITY_EFFECTS = {
  'Attraction': (ctx, poke) => { // 尼多娜（使用者自訂特性，2026-08-17新增）：每回合1次，從牌組
    // 把最多2張尼多力諾放上板凳——20張牌組每個卡名最多2張，「兩張」不算真的選擇（沒有可挑的
    // 空間，牌組裡有幾張尼多力諾就是那幾張），跟隨機搜尋（Weedle那張既有招式效果）同一套模式，
    // 差別是這裡是「全部符合的都搜出來」不是隨機挑1張，搜完要洗牌（真實TCG規則：主動搜牌庫
    // 之後要重洗，跟純隨機的那種不用特別洗牌不同）
    const benchSpace = 3 - ctx.side.bench.length;
    if (benchSpace <= 0) return '板凳已經滿了';
    const idxs = [];
    ctx.side.deck.forEach((c, i) => { if (c.category === 'Pokemon' && c.name === 'Nidorino') idxs.push(i); });
    if (!idxs.length) return '牌組沒有尼多力諾';
    const n = Math.min(2, benchSpace, idxs.length);
    const chosenIdxs = idxs.slice(0, n).sort((a, b) => b - a); // 從後面的index先移除，避免移除後前面index位移
    for (const i of chosenIdxs) {
      const [card] = ctx.side.deck.splice(i, 1);
      card.curHp = card.hp; card.energy = [];
      ctx.side.bench.push(card);
    }
    ctx.side.deck = pocketShuffle(ctx.side.deck);
    return null;
  },
  'Volt Charge': (ctx, poke) => { // Magneton：每回合1次，從能量區拿1電能量附到自己身上——2026-08-15
    // 應使用者要求，「填能」類特性/招式/道具效果不再受side.energyTypes（牌組能量屬性設定）限制，
    // 卡面固定寫死的能量屬性一律視為always可以生成，即使牌組沒選那個屬性也能發動
    poke.energy.push('Lightning');
    return null;
  },
  'Sleep Pendulum': (ctx) => { // Hypno：每回合1次，丟硬幣，正面讓對方主戰睡著
    if (ctx.oppSide.active && pocketFlipCoin(ctx)) ctx.oppSide.active.status = 'asleep';
    return null;
  },
  'Psy Shadow': (ctx) => { // Gardevoir：每回合1次，從能量區拿1超能力能量附給場上是超能力屬性的主戰
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Psychic')) return '主戰必須是超能力屬性';
    ctx.side.active.energy.push('Psychic');
    return null;
  },
  // Ignition（2026-08-08再修正）：卡面文字「Once during your turn, when you play this
  // Pokémon from your hand to evolve 1 of your Pokémon, you may...」確認過真的是「限定
  // 進化那個當下」的觸發窗口，不是每回合都能用（原本以為使用者反映的是「每回合可用」而
  // 一度改成button-anytime，後來使用者自己核對確認是搞混了，原始判斷才是對的）。真正的
  // 問題是「自動觸發、沒有任何按鈕/UI回饋」讓使用者以為特性沒實裝——解法：改成仍然限定
  // 「這隻的boardTurn===當前turnNumber」（進化上場的那一回合）才能用的按鈕，玩家要自己
  // 點才會觸發（比較符合原文"you may"的自主選擇，而不是自動幫玩家決定），過了那一回合
  // 按鈕就會消失（client端renderPokeSlot的evolveTurnOnly判斷），這樣「有沒有實裝」一目了然。
  'Ignition': (ctx, poke) => {
    if (poke.boardTurn !== ctx.G.turnNumber) return '這個特性只能在進化上場的那個回合使用';
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Fire')) return '主戰必須是火屬性';
    ctx.side.active.energy.push('Fire');
    return null;
  },
  'Gas Leak': (ctx, poke) => { // Weezing：只有在主戰位置時，每回合1次讓對方主戰中毒
    if (ctx.side.active?.uid !== poke.uid) return 'Weezing必須在主戰位置才能使用特性';
    if (ctx.oppSide.active) ctx.oppSide.active.poisoned = true;
    return null;
  },

  /* ── 2026-08-06新增：主動觸發型特性第二批——只做「按鈕觸發、每回合1次」這種現有機制已經
     支援的類型；「打出這張卡來進化時觸發」（Happy Ribbon/Search for Friends等）是完全不同的
     觸發時機（要掛在pocket_evolve handler，不是按鈕），這批先不做，維持「尚未支援」。
     單一目標的效果（Water Shuriken/Dark Chase/Captivating Rhythm/Extra Heal/Psychic Connect/
     Forest Breath/Psychic Healing）後來修正過，改成玩家自選目標(msg.target)，不是隨機挑——
     見feedback memory「Pocket效果「1 of your X」預設玩家自選不是隨機」。 ── */
  'Broken-Space Bellow': (ctx, poke) => { // 從能量區拿1超能力能量給自己，用了這個特性直接結束回合
    poke.energy.push('Psychic');
    ctx.endTurnAfter = true;
    return null;
  },
  'Roar in Unison': (ctx, poke) => { // 從能量區拿2惡屬性能量給自己，自己受到30傷害
    poke.energy.push('Darkness', 'Darkness');
    poke.curHp = Math.max(0, poke.curHp - 30);
    return null;
  },
  'Combust': (ctx, poke) => { // 從棄牌堆拿1火能量給自己，自己受到20傷害
    if (!pocketTakeEnergyFromDiscard(ctx.side, 'Fire')) return '棄牌堆沒有火屬性能量可以拿';
    poke.energy.push('Fire');
    poke.curHp = Math.max(0, poke.curHp - 20);
    return null;
  },
  'Watch Over': (ctx) => { // 治療主戰20血（不需要自己在主戰位置）
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const before = ctx.side.active.curHp;
    ctx.side.active.curHp = Math.min(ctx.side.active.hp, ctx.side.active.curHp + 20);
    ctx.healUid = ctx.side.active.uid; ctx.healAmount = ctx.side.active.curHp - before;
    return null;
  },
  'Comforting Song': (ctx) => { // 效果文字跟Watch Over完全一樣，共用同一段邏輯
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const before = ctx.side.active.curHp;
    ctx.side.active.curHp = Math.min(ctx.side.active.hp, ctx.side.active.curHp + 20);
    ctx.healUid = ctx.side.active.uid; ctx.healAmount = ctx.side.active.curHp - before;
    return null;
  },
  'Powder Heal': (ctx) => { // 治療己方全體20血
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) p.curHp = Math.min(p.hp, p.curHp + 20);
    return null;
  },
  'Fragrant Flower Garden': (ctx) => { // 治療己方全體10血
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) p.curHp = Math.min(p.hp, p.curHp + 10);
    return null;
  },
  // 2026-08-06修正（使用者第二次糾正同一個問題）：「1 of your opponent's Pokémon」沒有寫
  // at random，是使用特性的玩家自己選要打誰，不是隨機——client端先讓玩家點對手場上的目標，
  // 再把target uid送進msg
  'Water Shuriken': (ctx, poke, msg) => {
    const t = [ctx.oppSide.active, ...ctx.oppSide.bench].find(p => p && p.uid === msg.target);
    if (!t) return '請選擇對手場上的目標';
    t.curHp = Math.max(0, t.curHp - 20);
    return null;
  },
  'Drive Off': (ctx) => { // 把對手主戰換到板凳，對手選新主戰（跟Sabrina同一套）
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    const excludedUid = ctx.oppSide.active.uid; // 見Sabrina(A1-225)同一處excludeUid說明
    ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false;
    ctx.oppSide.bench.push(ctx.oppSide.active);
    ctx.oppSide.active = null;
    pocketEnterForcedSwitch(ctx.G, ctx.op, 'noEndTurn', excludedUid);
    return null;
  },
  'Repelling Wind': (ctx) => { // 同Drive Off但限定對手主戰必須是基礎寶可夢
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    if (ctx.oppSide.active.stage !== 'Basic') return '對手主戰不是基礎寶可夢';
    if (!ctx.oppSide.bench.length) return '對手沒有板凳寶可夢可以換上';
    const excludedUid = ctx.oppSide.active.uid; // 見Sabrina(A1-225)同一處excludeUid說明
    ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false;
    ctx.oppSide.bench.push(ctx.oppSide.active);
    ctx.oppSide.active = null;
    pocketEnterForcedSwitch(ctx.G, ctx.op, 'noEndTurn', excludedUid);
    return null;
  },
  'Data Scan': (ctx) => { if (ctx.side.deck.length) ctx.peekDeck = [ctx.side.deck[0]]; return null; },
  'Poison Coating': (ctx) => { if (ctx.oppSide.active && pocketFlipCoin(ctx)) ctx.oppSide.active.poisoned = true; return null; },
  'Energy Plunder': (ctx, poke) => { // 把己方全部場上寶可夢身上的惡屬性能量集中給自己
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(Boolean)) {
      if (p.uid === poke.uid) continue;
      const moved = p.energy.filter(e => e === 'Darkness');
      if (moved.length) { p.energy = p.energy.filter(e => e !== 'Darkness'); poke.energy.push(...moved); }
    }
    return null;
  },
  // 2026-08-06修正：目標（要換上場的是對手哪隻板凳）改成玩家自選，先選好目標再擲硬幣決定
  // 成不成功——跟Electric Generator同一種「選目標」跟「有沒有成功」分開處理的修法
  'Captivating Rhythm': (ctx, poke, msg) => {
    const idx = ctx.oppSide.bench.findIndex(p => p.uid === msg.target);
    if (idx < 0) return '請選擇對手板凳上的目標';
    if (!pocketFlipCoin(ctx)) return null;
    const chosen = ctx.oppSide.bench.splice(idx, 1)[0];
    if (ctx.oppSide.active) { ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false; ctx.oppSide.bench.push(ctx.oppSide.active); }
    ctx.oppSide.active = chosen;
    return null;
  },
  'Dark Chase': (ctx, poke, msg) => { // 只有在主戰位置時，把對手「身上有傷」的板凳換上主戰——玩家自選是哪一隻
    if (ctx.side.active?.uid !== poke.uid) return '必須在主戰位置才能使用特性';
    const idx = ctx.oppSide.bench.findIndex(p => p.uid === msg.target && p.curHp < p.hp);
    if (idx < 0) return '請選擇對手身上有傷的板凳寶可夢';
    const chosen = ctx.oppSide.bench.splice(idx, 1)[0];
    if (ctx.oppSide.active) { ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false; ctx.oppSide.bench.push(ctx.oppSide.active); }
    ctx.oppSide.active = chosen;
    return null;
  },
  'Slow Sear': (ctx) => { if (ctx.oppSide.deck.length) ctx.oppSide.discard.push(ctx.oppSide.deck.shift()); return null; },
  'Ice Maker': (ctx) => { // 主戰必須是水屬性，從能量區拿1水能量給主戰
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Water')) return '主戰必須是水屬性';
    ctx.side.active.energy.push('Water');
    return null;
  },
  'Cunning Link': (ctx) => { // 場上有Arceus/Arceus ex才能發動，對對手主戰造成30傷害
    const hasArceus = [ctx.side.active, ...ctx.side.bench].some(p => p && (p.name === 'Arceus' || p.name === 'Arceus ex'));
    if (!hasArceus) return '場上沒有Arceus或Arceus ex';
    if (ctx.oppSide.active) ctx.oppSide.active.curHp = Math.max(0, ctx.oppSide.active.curHp - 30);
    return null;
  },
  'Melodious Healing': (ctx) => { // 治療己方全體水屬性30血
    for (const p of [ctx.side.active, ...ctx.side.bench].filter(p => p && (p.types || []).includes('Water'))) {
      p.curHp = Math.min(p.hp, p.curHp + 30);
    }
    return null;
  },
  'Illuminate': (ctx) => { // 從牌庫隨機拿1隻寶可夢進手牌
    const idxs = ctx.side.deck.map((c, i) => c.category === 'Pokemon' ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); }
    return null;
  },
  'Fire Breath': (ctx) => { if (ctx.oppSide.active) ctx.oppSide.active.burned = true; return null; },
  // 2026-08-06修正：治療對象改成玩家自選（哪隻ex寶可夢），丟棄的能量本身卡面文字是
  // "a random Energy"，這部分維持隨機
  'Extra Heal': (ctx, poke, msg) => {
    const p = [ctx.side.active, ...ctx.side.bench].find(x => x && x.uid === msg.target && x.ex && x.energy.length);
    if (!p) return '請選擇己方身上帶著能量的ex寶可夢';
    const before = p.curHp;
    p.curHp = Math.min(p.hp, p.curHp + 60);
    const [t] = p.energy.splice(Math.floor(Math.random() * p.energy.length), 1);
    ctx.side.discardEnergy.push(t);
    ctx.healUid = p.uid; ctx.healAmount = p.curHp - before;
    return null;
  },
  'Passionate Voice': (ctx, poke) => { // 棄掉自己身上1點火能量，這回合己方火屬性攻擊+50
    if (!poke.energy.includes('Fire')) return '這隻寶可夢身上沒有火屬性能量';
    pocketDiscardEnergy(ctx.side, poke, 'Fire', 1);
    ctx.side.typeBoostThisTurn = { type: 'Fire', amount: 50 };
    return null;
  },
  // 2026-08-06修正：從哪隻板凳移動能量改成玩家自選
  'Psychic Connect': (ctx, poke, msg) => {
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const p = ctx.side.bench.find(x => x.uid === msg.target && x.energy.includes('Psychic'));
    if (!p) return '請選擇板凳上帶著超能力能量的寶可夢';
    const moved = p.energy.filter(e => e === 'Psychic');
    p.energy = p.energy.filter(e => e !== 'Psychic');
    ctx.side.active.energy.push(...moved);
    return null;
  },
  'Rising Road': (ctx, poke) => { // 只有在板凳時可以跟主戰互換上場
    if (ctx.side.active?.uid === poke.uid) return '這隻寶可夢已經在主戰位置';
    if (!ctx.side.active) return '沒有主戰寶可夢可以互換';
    const idx = ctx.side.bench.findIndex(p => p.uid === poke.uid);
    if (idx < 0) return null;
    const oldActive = ctx.side.active;
    oldActive.status = null; oldActive.poisoned = false; oldActive.burned = false;
    ctx.side.bench[idx] = oldActive;
    ctx.side.active = poke;
    return null;
  },
  // 2026-08-06修正：要附加給哪隻草系寶可夢（含自己）改成玩家自選
  'Forest Breath': (ctx, poke, msg) => {
    if (ctx.side.active?.uid !== poke.uid) return '必須在主戰位置才能使用特性';
    const target = [ctx.side.active, ...ctx.side.bench].find(p => p.uid === msg.target && (p.types || []).includes('Grass'));
    if (!target) return '請選擇己方場上的草屬性寶可夢';
    target.energy.push('Grass');
    return null;
  },
  // 2026-08-06修正：治療對象改成玩家自選，不限定必須已經受傷（卡面沒有這個限制）
  'Psychic Healing': (ctx, poke, msg) => {
    if (ctx.side.active?.uid !== poke.uid) return '必須在主戰位置才能使用特性';
    const p = [ctx.side.active, ...ctx.side.bench].find(x => x.uid === msg.target);
    if (!p) return '請選擇己方場上的目標';
    const before = p.curHp;
    p.curHp = Math.min(p.hp, p.curHp + 30);
    ctx.healUid = p.uid; ctx.healAmount = p.curHp - before;
    return null;
  },

  /* ── 2026-08-07新增：主動觸發型特性第三批 ── */
  'Fragrance Trap': (ctx, poke, msg) => { // 必須在主戰位置，把對手指定的1隻基礎板凳換上場
    if (ctx.side.active?.uid !== poke.uid) return '必須在主戰位置才能使用特性';
    const idx = ctx.oppSide.bench.findIndex(p => p.uid === msg.target && p.stage === 'Basic');
    if (idx < 0) return '請選擇對手板凳上的基礎寶可夢';
    const chosen = ctx.oppSide.bench.splice(idx, 1)[0];
    if (ctx.oppSide.active) { ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false; ctx.oppSide.bench.push(ctx.oppSide.active); }
    ctx.oppSide.active = chosen;
    return null;
  },
  // Ultra Beast是官方一個固定的物種分類（Nihilego/Buzzwole/Pheromosa/Xurkitree/Celesteela/
  // Kartana/Guzzlord/Poipole/Naganadel/Stakataka/Blacephalon），卡片資料裡沒有對應的tag欄位，
  // 用名字清單比對——跟Blaine/Kiawe這類指名寶可夢清單同一種做法，不是猜測
  'Ultra Thrusters': (ctx, poke, msg) => {
    const ULTRA_BEASTS = ['Nihilego', 'Buzzwole', 'Pheromosa', 'Xurkitree', 'Celesteela', 'Kartana', 'Guzzlord', 'Poipole', 'Naganadel', 'Stakataka', 'Blacephalon'];
    const activeName = ctx.side.active?.name?.replace(/ ex$/, '');
    if (!ctx.side.active || !ULTRA_BEASTS.includes(activeName)) return '主戰必須是究極異獸';
    const idx = ctx.side.bench.findIndex(p => p.uid === msg.target && ULTRA_BEASTS.includes(p.name.replace(/ ex$/, '')));
    if (idx < 0) return '請選擇板凳上的究極異獸';
    const bench = ctx.side.bench[idx];
    const oldActive = ctx.side.active;
    oldActive.status = null; oldActive.poisoned = false; oldActive.burned = false;
    ctx.side.bench[idx] = oldActive;
    ctx.side.active = bench;
    return null;
  },
  'Catching Tail': (ctx) => { // 牌庫隨機1張寶可夢工具卡進手牌（卡面文字本身寫"random"）
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Trainer' && c.trainerType === 'Tool') ? i : -1).filter(i => i >= 0);
    if (idxs.length) { const i = idxs[Math.floor(Math.random() * idxs.length)]; ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]); }
    return null;
  },
  'Shifting Stream': (ctx, poke, msg) => { // 主戰必須是水屬性，跟玩家指定的板凳互換（不限自己是不是主戰持有者）
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Water')) return '主戰必須是水屬性';
    const idx = ctx.side.bench.findIndex(p => p.uid === msg.target);
    if (idx < 0) return '請選擇板凳上的目標';
    const bench = ctx.side.bench[idx];
    const oldActive = ctx.side.active;
    oldActive.status = null; oldActive.poisoned = false; oldActive.burned = false;
    ctx.side.bench[idx] = oldActive;
    ctx.side.active = bench;
    return null;
  },
  // 2026-08-08新增：第三批按鈕觸發型特性
  // 2026-08-12修正：原本隨機棄1張手牌——卡面「discard a card from your hand」沒有"at random"字樣，
  // 依專案既有慣例（[[feedback_pocket_effect_choice_not_random]]）該讓玩家自選要棄哪張，不是隨機。
  // client端先用openDiscardTargetPicker跳出手牌選擇器，選完才送pocket_use_ability帶discardHandUid。
  'Reckless Shearing': (ctx, poke, msg) => {
    if (!ctx.side.hand.length) return '手牌是空的，無法使用這個特性';
    const idx = ctx.side.hand.findIndex(c => c.uid === msg?.discardHandUid);
    if (idx < 0) return '請選擇要棄掉的手牌';
    ctx.side.discard.push(ctx.side.hand.splice(idx, 1)[0]);
    if (ctx.side.deck.length) ctx.side.hand.push(ctx.side.deck.shift());
    return null;
  },
  // CHECK：原文「choose either player」可以挑對手的牌庫看——已知簡化，這裡固定看自己牌庫頂1張，
  // 不做「選對手」的介面（跟其他needsTarget選寶可夢不同，這是選玩家不是選board目標，UI成本較高、
  // 對戰局影響也小，判斷不值得為單一張卡建一整套新的選擇機制）
  'CHECK': (ctx) => { if (ctx.side.deck.length) ctx.peekDeck = [ctx.side.deck[0]]; return null; },
  'Wash Out': (ctx, poke, msg) => { // 從玩家指定的板凳水屬性寶可夢身上移1點水能量給主戰（主戰也要是水屬性）
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Water')) return '主戰必須是水屬性';
    const src = ctx.side.bench.find(p => p.uid === msg.target);
    if (!src || !(src.types || []).includes('Water')) return '請選擇板凳上的水屬性寶可夢';
    const idx = src.energy.indexOf('Water');
    if (idx < 0) return '這隻沒有水屬性能量可以移動';
    src.energy.splice(idx, 1);
    ctx.side.active.energy.push('Water');
    return null;
  },
  // Fan Made系列（2026-08-10新增，2026-08-11修正移動方式）：捷克羅姆ex/萊希拉姆ex的
  // 「渦輪電壓/渦輪火焰」——使用者明確要求「玩家可以自由選擇怎麼移動能量」，不是一次把整隻
  // 板凳寶可夢身上符合屬性的能量全部強制搬空。改成每次觸發只移動選定來源身上「1點」符合屬性
  // 的能量（挑哪隻、要不要繼續移下一點，都是玩家自己決定）——真正的「自由」在於這個特性沒有
  // 「Once during your turn」限定語、不限每回合1次（見pocket_use_ability的unlimitedUse白名單，
  // 跟Shadow Void同一個判例），玩家可以連續點好幾次特性按鈕、每次挑不同板凳來源，湊出他想要的
  // 任意能量分配結果，而不是被迫一次全部倒過去。跟Wash Out的差別只剩①不限制主戰屬性（卡面沒
  // 寫主戰要是電/火屬性）②不限每回合1次。
  '渦輪電壓': (ctx, poke, msg) => {
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const src = ctx.side.bench.find(p => p.uid === msg.target);
    if (!src) return '請選擇板凳上的寶可夢';
    const idx = src.energy.indexOf('Lightning');
    if (idx < 0) return '這隻沒有電屬性能量可以移動';
    src.energy.splice(idx, 1);
    ctx.side.active.energy.push('Lightning');
    return null;
  },
  '渦輪火焰': (ctx, poke, msg) => {
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const src = ctx.side.bench.find(p => p.uid === msg.target);
    if (!src) return '請選擇板凳上的寶可夢';
    const idx = src.energy.indexOf('Fire');
    if (idx < 0) return '這隻沒有火屬性能量可以移動';
    src.energy.splice(idx, 1);
    ctx.side.active.energy.push('Fire');
    return null;
  },
  'Dismantling Keys': (ctx, poke) => { // 必須在板凳上才能用，棄掉對手主戰的工具卡+棄掉自己
    if (!ctx.side.bench.some(p => p.uid === poke.uid)) return '必須在板凳上才能使用這個特性';
    if (!ctx.oppSide.active?.tool) return '對手主戰沒有裝備寶可夢工具卡';
    ctx.oppSide.active.tool = null;
    const idx = ctx.side.bench.findIndex(p => p.uid === poke.uid);
    ctx.side.bench.splice(idx, 1);
    poke.tool = null;
    ctx.side.discard.push(poke);
    return null;
  },
  // 2026-08-08再接續：Shadow Void——「as often as you like」，跟其他特性不同，這個名字被
  // 白名單跳過pocket_use_ability的once-per-turn gate（見那裡的unlimitedUse判斷），玩家可以
  // 同一回合內對這隻連續呼叫這個訊息很多次，每次都要重新選目標
  'Shadow Void': (ctx, poke, msg) => {
    const src = [ctx.side.active, ...ctx.side.bench].find(p => p && p.uid === msg.target && p.uid !== poke.uid && p.curHp < p.hp);
    if (!src) return '請選擇1隻己方有受傷的寶可夢（不能選自己）';
    const dmg = src.hp - src.curHp;
    src.curHp = src.hp;
    poke.curHp = Math.max(0, poke.curHp - dmg);
    return null;
  },
  // Portrait（2026-08-08新增）：借用對手手牌隨機1張支援者卡的效果——直接呼叫TRAINER_EFFECTS
  // 裡對應的handler（該表這時候已經是完整初始化好的top-level const，這個閉包執行時一定讀得到），
  // 用空msg呼叫，如果借來的效果需要msg.target(玩家互動選擇)而我們沒有提供，handler會回傳
  // 錯誤字串——這裡直接忽略那個錯誤（安靜視為「這次沒有效果」），不會讓Portrait自己也失敗。
  // 「you may」但沒有明顯downside，比照EVOLVE_TRIGGER_ABILITIES的既有慣例自動觸發，不用額外UI
  'Portrait': (ctx) => {
    const eligible = ctx.oppSide.hand.filter(c => c.category === 'Trainer' && c.trainerType === 'Supporter');
    if (!eligible.length) return null;
    const picked = eligible[Math.floor(Math.random() * eligible.length)];
    const handler = TRAINER_EFFECTS[picked.effectId || picked.id];
    if (handler) handler(ctx, {});
    return null;
  },

  /* ── 2026-08-08新增：B2b~B4系列特性第一批 ── */
  'Frozen Flow': (ctx, poke) => { // 只有在主戰位置時，把對手主戰換到板凳（對手自選新主戰），跟Gas Leak同一類「必須在主戰」限制
    if (ctx.side.active?.uid !== poke.uid) return '必須在主戰位置才能使用特性';
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    const excludedUid = ctx.oppSide.active.uid; // 見Sabrina(A1-225)同一處excludeUid說明
    ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false;
    ctx.oppSide.bench.push(ctx.oppSide.active);
    ctx.oppSide.active = null;
    pocketEnterForcedSwitch(ctx.G, ctx.op, 'noEndTurn', excludedUid);
    return null;
  },
  'Perplexing Ears': (ctx, poke) => { // 只有在主戰位置時，讓對手主戰混亂
    if (ctx.side.active?.uid !== poke.uid) return '必須在主戰位置才能使用特性';
    if (ctx.oppSide.active) ctx.oppSide.active.status = 'confused';
    return null;
  },
  'Accept Pain': (ctx, poke) => { // 只有在板凳時，把自己主戰身上30傷害轉移到自己身上
    if (ctx.side.active?.uid === poke.uid) return '必須在板凳上才能使用特性';
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const move = Math.min(30, ctx.side.active.hp - ctx.side.active.curHp);
    if (move <= 0) return '主戰目前沒有可以轉移的傷害';
    ctx.side.active.curHp = Math.min(ctx.side.active.hp, ctx.side.active.curHp + move);
    poke.curHp = Math.max(0, poke.curHp - move);
    return null;
  },
  'Happiness Supplement': (ctx) => { // 移除自己主戰身上一個隨機異常狀態——2026-08-13改用
    // pocketRemoveRandomCondition（跟Big Malasada共用同一套邏輯，見定義處說明）
    if (!pocketRemoveRandomCondition(ctx.side.active)) return '主戰目前沒有異常狀態';
    return null;
  },
  'Aqua Charge': (ctx, poke) => { // 從能量區拿1水能量附給自己
    poke.energy.push('Water');
    return null;
  },
  // Variety Powder：卡面明確寫"chosen at random"，跟一般「1 of your X」預設玩家自選不同，
  // 這張本來就該用Math.random——見feedback memory「Pocket效果「1 of your X」預設玩家自選不是隨機」
  'Variety Powder': (ctx) => {
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    const pool = ['burned', 'confused', 'poisoned'].filter(s => !pocketHasCondition(ctx.oppSide.active, s));
    if (!pool.length) return '對手主戰已經受到這些異常狀態影響';
    pocketSetCondition(ctx.oppSide.active, pool[Math.floor(Math.random() * pool.length)]);
    return null;
  },
  // 2026-08-08修正：原本誤把{N}(龍屬性)當成「能量本身要是龍屬性」，實際卡面「take AN
  // Energy...to your Active {N} Pokémon」——{N}限制的是目標主戰必須是龍屬性，能量本身
  // 任意屬性都可以。第二次修正：一開始用「棄牌堆第一個找到的」，但卡面沒寫at random，
  // 依專案既有慣例（feedback_pocket_effect_choice_not_random）該讓玩家自選要拿哪一種——
  // client端先跳出picker讓玩家選好energyType再送出，這裡改成驗證msg.energyType真的存在
  // 棄牌堆裡才能拿，不是伺服器自己決定
  'Dragon’s Blessing': (ctx, poke, msg) => { // 只有在板凳時，從棄牌堆拿1個玩家指定屬性的能量附給自己的龍屬性主戰
    if (ctx.side.active?.uid === poke.uid) return '必須在板凳上才能使用特性';
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Dragon')) return '主戰必須是龍屬性';
    if (!msg?.energyType) return '請選擇要拿哪一種能量';
    if (!pocketTakeEnergyFromDiscard(ctx.side, msg.energyType)) return '棄牌堆沒有這種能量可以拿';
    ctx.side.active.energy.push(msg.energyType);
    return null;
  },
  'Metal Transport': (ctx, poke, msg) => { // 主戰必須是鋼屬性，跟板凳上任一隻交換（玩家自選，跟其他「1 of your X」同慣例）
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Metal')) return '主戰必須是鋼屬性';
    const idx = ctx.side.bench.findIndex(p => p.uid === msg.target);
    if (idx < 0) return '請選擇板凳上要換上場的寶可夢';
    const chosen = ctx.side.bench.splice(idx, 1)[0];
    ctx.side.active.status = null; ctx.side.active.poisoned = false; ctx.side.active.burned = false;
    ctx.side.bench.push(ctx.side.active);
    ctx.side.active = chosen;
    return null;
  },
  'Soothing Ribbon': (ctx, poke, msg) => { // 自己必須裝備道具卡，治療己方任一隻30血（玩家自選目標）
    if (!poke.tool) return '這隻寶可夢必須裝備道具卡才能使用特性';
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要治療的寶可夢';
    const before = target.curHp;
    target.curHp = Math.min(target.hp, target.curHp + 30);
    if (target.curHp === before) return '這隻寶可夢血量已滿';
    ctx.healUid = target.uid; ctx.healAmount = target.curHp - before;
    return null;
  },
  // 以下7個都是「Once during your turn, when you play/put this Pokémon...evolve/onto your
  // Bench, you may...」句型——跟Ignition同一種修法：限定在「進化上場/放上板凳的那個回合」才能
  // 用的按鈕（poke.boardTurn===ctx.G.turnNumber），而不是自動觸發，見Ignition那段完整說明。
  // pocket_bench_play跟pocket_evolve都會設boardTurn=G.turnNumber，所以這個guard對兩種
  // 觸發時機（進化/上板凳）通用，不用分開處理。
  'Swift Shot': (ctx, poke) => { // Drizzile 20傷害／Inteleon 30傷害——同名不同數值，用poke.name分支
    if (poke.boardTurn !== ctx.G.turnNumber) return '這個特性只能在上場的那個回合使用';
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    const dmg = poke.name === 'Inteleon' ? 30 : 20;
    ctx.oppSide.active.curHp = Math.max(0, ctx.oppSide.active.curHp - dmg);
    return null;
  },
  'Legendary Drive': (ctx, poke) => { // 跟主戰交換，並把「場上」(原主戰+全部板凳，不只原主戰一隻)身上全部能量移到新主戰身上
    if (poke.boardTurn !== ctx.G.turnNumber) return '這個特性只能在上場的那個回合使用';
    if (!ctx.side.active) return '沒有主戰寶可夢';
    const oldActive = ctx.side.active;
    const idx = ctx.side.bench.findIndex(p => p.uid === poke.uid);
    if (idx < 0) return '這隻寶可夢不在板凳上';
    ctx.side.bench.splice(idx, 1);
    oldActive.status = null; oldActive.poisoned = false; oldActive.burned = false;
    ctx.side.bench.push(oldActive);
    ctx.side.active = poke;
    for (const p of ctx.side.bench) { poke.energy.push(...p.energy); p.energy = []; }
    return null;
  },
  'Ancient Roar': (ctx, poke) => { // 把對手主戰換到板凳（對手自選新主戰）
    if (poke.boardTurn !== ctx.G.turnNumber) return '這個特性只能在上場的那個回合使用';
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    const excludedUid = ctx.oppSide.active.uid; // 見Sabrina(A1-225)同一處excludeUid說明
    ctx.oppSide.active.status = null; ctx.oppSide.active.poisoned = false; ctx.oppSide.active.burned = false;
    ctx.oppSide.bench.push(ctx.oppSide.active);
    ctx.oppSide.active = null;
    pocketEnterForcedSwitch(ctx.G, ctx.op, 'noEndTurn', excludedUid);
    return null;
  },
  'Hospitality': (ctx, poke) => { // 治療自己的草屬性主戰20血
    if (poke.boardTurn !== ctx.G.turnNumber) return '這個特性只能在上場的那個回合使用';
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Grass')) return '主戰必須是草屬性';
    const before = ctx.side.active.curHp;
    ctx.side.active.curHp = Math.min(ctx.side.active.hp, ctx.side.active.curHp + 20);
    ctx.healUid = ctx.side.active.uid; ctx.healAmount = ctx.side.active.curHp - before;
    return null;
  },
  'Stance': (ctx, poke) => { // 直到對手下回合結束前，完全免疫傷害跟效果——重用既有的invulnerableUntilTurn欄位
    if (poke.boardTurn !== ctx.G.turnNumber) return '這個特性只能在上場的那個回合使用';
    poke.invulnerableUntilTurn = ctx.G.turnNumber + 1;
    return null;
  },
  'Evoshock': (ctx, poke) => { // 擲硬幣，正面讓對手主戰麻痺
    if (poke.boardTurn !== ctx.G.turnNumber) return '這個特性只能在上場的那個回合使用';
    if (ctx.oppSide.active && pocketFlipCoin(ctx)) ctx.oppSide.active.status = 'paralyzed';
    return null;
  },
  'Treasure Collecting': (ctx, poke) => { // 看牌庫頂4張，道具卡全部進手牌，其餘洗回牌庫
    if (poke.boardTurn !== ctx.G.turnNumber) return '這個特性只能在上場的那個回合使用';
    const top = ctx.side.deck.splice(0, Math.min(4, ctx.side.deck.length));
    const items = top.filter(c => c.category === 'Trainer' && c.trainerType === 'Item');
    const rest = top.filter(c => !items.includes(c));
    ctx.side.hand.push(...items);
    ctx.side.deck = pocketShuffle([...ctx.side.deck, ...rest]);
    return null;
  },
  '覺醒': (ctx, poke) => { // 圓陸鯊(FM-004，Fan Made，2026-08-12新增)：在場上度過一個回合後，
    // 可以直接從牌組把「烈咬陸鯊」(非ex，跳過中間的尖牙陸鯊階)疊上來進化——跟Rare Candy
    // (A3-144)同一套「Object.assign整隻換掉」evolve邏輯，只是來源是牌組不是手牌，目標卡
    // 固定是烈咬陸鯊(非ex)，不像Rare Candy那樣泛用比對任意Stage1鏈。client端按鈕在
    // notYetOnBoard擋掉「剛上場那回合」，這裡authoritative再檢查一次。
    if (poke.boardTurn >= ctx.G.turnNumber) return '這隻寶可夢這回合剛上場，不能使用';
    const idx = ctx.side.deck.findIndex(c => c.category === 'Pokemon' && c.name === 'Garchomp');
    if (idx < 0) return '牌組沒有「烈咬陸鯊」可以進化';
    const deckCard = ctx.side.deck.splice(idx, 1)[0];
    const preservedDamage = (poke.hp || 0) - (poke.curHp ?? poke.hp ?? 0);
    const preservedEnergy = poke.energy;
    const preservedUid = poke.uid;
    Object.assign(poke, structuredClone(POCKET_CARDS_BY_ID[deckCard.id]));
    poke.uid = preservedUid; poke.energy = preservedEnergy;
    poke.status = null; poke.poisoned = false; poke.burned = false; // 2026-08-16應使用者要求：進化時異常狀態要清掉
    poke.curHp = Math.max(1, (poke.hp || 0) - preservedDamage);
    poke.boardTurn = ctx.G.turnNumber;
    poke._realAbilities = undefined; // 進化後身分變了，清掉舊快取讓特性正確重抓（同Rare Candy）
    pocketApplyDoubleType(poke);
    return null;
  },
};
// 從棄牌堆裡任何一張還留有該屬性能量的寶可夢卡上拿1點能量（真實Pocket規則的棄牌堆同時
// 存放卡片跟已丟棄的能量——我們的引擎沒有獨立的能量棄牌堆，改成直接掃discard裡的寶可夢
// 卡物件本身殘留的.energy陣列，找到就扣掉那一點，語意上等價）
function pocketTakeEnergyFromDiscard(side, type) {
  // 2026-08-08新增：先查沒有卡片可以掛的「純能量」棄牌區（見discardEnergy欄位說明），
  // 找不到再退回原本掃殘留在被擊倒寶可夢卡身上的能量——兩個來源合起來才是完整的棄牌堆
  const looseIdx = (side.discardEnergy || []).indexOf(type);
  if (looseIdx >= 0) { side.discardEnergy.splice(looseIdx, 1); return true; }
  for (const c of side.discard) {
    if (c.energy?.includes(type)) { c.energy.splice(c.energy.indexOf(type), 1); return true; }
  }
  return false;
}
/* ── 2026-08-07新增：進化觸發型特性（"when you play this Pokémon from your hand to evolve
   1 of your Pokémon, you may..."）——跟按鈕觸發型是完全不同的時機，掛在pocket_evolve handler，
   進化完成後自動判定。全部都是"you may"(可選)，但沒有UI可以問玩家「要不要用」，也沒有明顯
   會讓玩家想拒絕的理由（都是純粹利己的效果），簡化成一律自動觸發。
   Healing Ripples/Search for Friends這2個效果裡「1 of your X」/「a Supporter card」沒寫
   random，玩家要自選——2026-08-07再擴充：讓函式可以在ctx上設ctx.needsChoice（跟ATTACK_EFFECTS
   同一套convention），pocket_evolve handler檢查到就暫停進attack_choice phase等玩家選擇，
   跟pick_target的解析邏輯完全共用（見pocket_attack_choice handler），只是多一個
   pending.noEndTurn=true旗標——進化本身不會結束回合，跟攻擊觸發的選擇不同，解析完不能
   自動pocketAdvanceTurn。 ── */
const EVOLVE_TRIGGER_ABILITIES = {
  'Happy Ribbon': (ctx) => { ctx.side.hand.push(...ctx.side.deck.splice(0, Math.min(2, ctx.side.deck.length))); },
  'Healing Ripples': (ctx) => { // 60血治療，限定自己的水屬性寶可夢，不限主戰/板凳（pool:'ownAll'）
    const eligible = [ctx.side.active, ...ctx.side.bench].filter(p => p && (p.types || []).includes('Water') && p.curHp < p.hp);
    if (eligible.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownAll', eligibleUids: eligible.map(p => p.uid), action: 'heal', amount: 60, noEndTurn: true };
  },
  'Search for Friends': (ctx) => { // 從自己棄牌堆選1張支援者卡進手牌
    const eligible = ctx.side.discard.filter(c => c.category === 'Trainer' && c.trainerType === 'Supporter');
    if (eligible.length) ctx.needsChoice = { kind: 'pick_target', pool: 'ownDiscardSupporter', eligibleUids: eligible.map(c => c.uid), action: 'toHand', noEndTurn: true };
  },
  'Dig Up': (ctx) => { // 從己方棄牌堆隨機挑最多2張寶可夢工具卡進手牌（卡面文字本身寫的是"random"）
    for (let i = 0; i < 2; i++) {
      const idxs = ctx.side.discard.map((c, j) => (c.category === 'Trainer' && c.trainerType === 'Tool') ? j : -1).filter(j => j >= 0);
      if (!idxs.length) break;
      const j = idxs[Math.floor(Math.random() * idxs.length)];
      ctx.side.hand.push(ctx.side.discard.splice(j, 1)[0]);
    }
  },
  'Unruly Claw': (ctx) => { if (ctx.oppSide.active?.energy.length) { const [t] = ctx.oppSide.active.energy.splice(Math.floor(Math.random() * ctx.oppSide.active.energy.length), 1); ctx.oppSide.discardEnergy.push(t); } },
  'Refreshing Tea': (ctx) => {
    const drawCount = Math.max(0, 3 - ctx.oppSide.points);
    ctx.oppSide.deck = pocketShuffle([...ctx.oppSide.deck, ...ctx.oppSide.hand]);
    ctx.oppSide.hand = ctx.oppSide.deck.splice(0, Math.min(drawCount, ctx.oppSide.deck.length));
  },
};
// Power of Alchemy（2026-08-08新增）：「Basic Pokémon in play (both yours and your opponent's)
// have no Abilities」——這個引擎裡`poke.abilities?.[0]?.name`這種讀法分散在33處，改成統一經過
// helper函式風險高（漏改就會不一致），改用「直接抽換poke.abilities本身」：真正的特性資料備份在
// `poke._realAbilities`，判定要封鎖時把`poke.abilities`暫時清空成`[]`，這樣全部既有讀取點完全
//不用改，天然讀到undefined。只在`pocketBroadcastState`這一個「每次狀態變更後都必經」的關卡
// 統一重新計算，不用在每個「board組成可能改變」的地方各自呼叫（bench_play/evolve/KO/棄牌/
// 洗回牌庫等散布幾十處，逐一補呼叫風險比這個高很多）。
// 已知簡化：Power of Alchemy持有者自己如果剛好是Basic階（現有卡池的Alolan Muk是Stage1，
// 不會發生），不特別處理自我悖論（"我封鎖了自己導致條件不成立"的無限迴圈），因為目前資料
// 不會踩到這個情況。
function pocketSyncAbilitySuppression(G) {
  const anyAlchemy = ['p1', 'p2'].some(r => [G[r]?.active, ...(G[r]?.bench || [])].some(p => {
    const real = p?._realAbilities ?? p?.abilities;
    return real?.[0]?.name === 'Power of Alchemy';
  }));
  for (const r of ['p1', 'p2']) {
    if (!G[r]) continue;
    for (const p of [G[r].active, ...G[r].bench]) {
      if (!p) continue;
      if (p._realAbilities === undefined) p._realAbilities = p.abilities;
      const isAlchemyHolder = p._realAbilities?.[0]?.name === 'Power of Alchemy';
      // Prickly Powder（2026-08-08新增）：跟Power of Alchemy的封鎖條件不同方向（這個是「這隻
      // 自己被打過這招」的個體標記，不是隊伍條件），跟anyAlchemy的封鎖用同一個||短路
      p.abilities = (p._abilitiesLockedOff || (anyAlchemy && p.stage === 'Basic' && !isAlchemyHolder)) ? [] : p._realAbilities;
    }
  }
}
// 動態HP（2026-08-08新增）：Toughness Aroma(隊伍型，own side有Lilligant時己方全部草屬性+20)/
// Infinite Increase(自己身上超能力能量數量×30)/Starting Plains(場地卡，雙方基礎階都+20)——
// 這個引擎的curHp存的是「剩餘血量絕對值」不是「已受傷量」，動態調整hp上限時如果不同步調整
// curHp，等於憑空多冒出/減少「已受傷量」的認知。解法：記錄每隻寶可夢「目前已套用的加成」
// (`_hpBonus`)，只在加成**改變**的那一刻，把hp/curHp同步加減同一個delta——這樣「已受傷量」
// (hp-curHp)在加成變動前後維持不變，等同真實規則「傷害計數器不受HP上限變動影響」的效果。
// 一樣掛在pocketBroadcastState這個唯一必經關卡（不用在每個「場上組成/能量可能改變」的地方
// 各自呼叫），且必須排在pocketSyncAbilitySuppression之後——Toughness Aroma如果因為Power of
// Alchemy被封鎖，這裡讀到的p.abilities已經反映封鎖後的狀態，天然正確。
function pocketSyncHpBonuses(G) {
  for (const r of ['p1', 'p2']) {
    if (!G[r]) continue;
    const side = G[r];
    for (const p of [side.active, ...side.bench]) {
      if (!p) continue;
      let bonus = 0;
      if ((p.types || []).includes('Grass') && [side.active, ...side.bench].some(q => q?.abilities?.[0]?.name === 'Toughness Aroma')) bonus += 20;
      if (p.abilities?.[0]?.name === 'Infinite Increase') bonus += p.energy.filter(e => e === 'Psychic').length * 30;
      if (G.activeStadium?.id === 'B2-154' && p.stage === 'Basic') bonus += 20;
      const oldBonus = p._hpBonus || 0;
      if (bonus !== oldBonus) {
        const delta = bonus - oldBonus;
        p.hp = Math.max(10, (p.hp || 0) + delta);
        p.curHp = Math.max(0, Math.min(p.hp, (p.curHp ?? p.hp) + delta));
        p._hpBonus = bonus;
      }
    }
  }
}
// 2026-08-14新增：HP加成來源（場地/特性，見pocketSyncHpBonuses）被移除時，上面那個函式已經
// 正確把curHp扣到0了，但「倒下」這件事（棄置/加分/進forced_switch）從來沒有人真的觸發——
// 這個函式補上這一步。只在G.phase==='active'才跑：'attack_choice'/'forced_switch'代表當下
// 正卡在別的流程中間（例如攻擊傷害本身就是KO但還要等玩家selectchoice——見
// pocketResolveDeferredKO的deferredKO機制），這時候curHp<=0是暫時性的、KO判定會由那個
// 流程自己收尾，這裡不能搶著判，不然deferredKO的效果會被跳過。endsTurn=false：不是攻擊/
// 中毒造成的KO，跟特性直接擊倒對手同一個道理（見pocket_use_ability handler），不該連帶
// 結束回合。
function pocketResolveAmbientKOs(G) {
  if (G.phase !== 'active') return;
  for (const role of ['p1', 'p2']) {
    const side = G[role];
    if (!side) continue;
    const op = role === 'p1' ? 'p2' : 'p1';
    pocketResolveBenchKOs(G, side, op);
    if (G.phase === 'active' && side.active && side.active.curHp <= 0) {
      pocketResolveActiveKO(G, role, true, false);
    }
  }
}
// Memory Light（2026-08-08新增）：把pocketEffectiveMoves算好的清單放進`effectiveAttacks`，
// client端渲染攻擊按鈕時改讀這個欄位（沒裝備的寶可夢這個欄位就跟attacks完全一樣）
function pocketSyncEffectiveAttacks(G) {
  for (const r of ['p1', 'p2']) {
    if (!G[r]) continue;
    for (const p of [G[r].active, ...G[r].bench]) {
      if (p) p.effectiveAttacks = pocketEffectiveMoves(p, G[r]);
    }
  }
}
function pocketBroadcastState(pRoom) {
  const G = pRoom.G;
  pocketSyncAbilitySuppression(G);
  pocketSyncHpBonuses(G);
  pocketResolveAmbientKOs(G);
  pocketSyncEffectiveAttacks(G);
  send(pRoom.p1, { type: 'pocket_turn_state', ...pocketViewFor(G, 'p1') });
  send(pRoom.p2, { type: 'pocket_turn_state', ...pocketViewFor(G, 'p2') });
}

function freshBuff() {
  return {
    atkBonus: 0, atkMult: 1, shield: 0, typeOverride: null, reflect: false,
    doubleStrike: false, typeBoost: null, debuffReflect: false, guaranteedStatus: false,
    costFreeType: null, costHalved: false, ignoreReflectNext: false, iceHowlFreeze: false,
    ignoreShield: false, iceImmune: false,
  };
}
// 封印特性（ability-seal）／詛咒（heal-seal，2026-07-22新增）：G沒有全域state（每個room各自一份），
// 所以跟其他判斷一樣要把G/role明確傳進來，不能像單人版那樣直接讀模組層級的G。
function isAbilitySealedSrv(role, G) { return (G[`${role}AbilitySealedTurns`] || 0) > 0; }
// 2026-07-23：暗夜詛咒領域場地啟用時，雙方都視為被封印
function isHealSealedSrv(role, G) {
  if (G.activeStadium?.id === 'stadium-dark-curse') return true;
  // 深淵支配（伊裴爾塔爾）：這隻寶可夢在場上時，對方無法回復HP——常駐效果，不是計次的封印
  const op = role === 'p1' ? 'p2' : 'p1';
  const oppActive = G[`${op}Deck`]?.[G[`${op}Idx`]];
  if (oppActive?.ability?.id === 'dark-abyss-lockdown') return true;
  return (G[`${role}HealSealedTurns`] || 0) > 0;
}
// 帕路奇亞「空間切割」（space-cut，2026-08-14新增）：對手不能發動競技場（卡片+特性自動切換都算），
// 僅限帕路奇亞還在場上時持續生效——跟pokemon_battle.html的spaceCutBlocks()同一套邏輯，
// 檢查actingRole的對面是不是space-cut持有者，用來擋actingRole自己想切換場地的動作
function spaceCutBlocksSrv(G, actingRole) {
  const opRole = actingRole === 'p1' ? 'p2' : 'p1';
  if (isAbilitySealedSrv(opRole, G)) return false;
  const opPoke = G[`${opRole}Deck`]?.[G[`${opRole}Idx`]];
  return !!opPoke && opPoke.cur > 0 && opPoke.ability?.id === 'space-cut';
}
// 2026-08-13新增：異常狀態解除封鎖，跟isHealSealedSrv同一種「掛在既有call site」寫法，但是
// 針對「特定一種異常狀態能不能被解除」而不是HP回復——亡靈墓園擋全部、劇毒領域只擋中毒、
// 熔岩火山只擋燒傷。effectType是status物件的.type欄位（'poison'/'burn'/...）
function isStatusCureBlockedSrv(G, effectType) {
  if (G.activeStadium?.id === 'stadium-ghost-curse') return true;
  if (G.activeStadium?.id === 'stadium-toxic-field' && effectType === 'poison') return true;
  if (G.activeStadium?.id === 'stadium-lava' && effectType === 'burn') return true;
  return false;
}

// 2026-07-29新增：每回合開始「額外抽到指定卡片」的特性——強子引擎(密勒頓)/緋紅脈動(故勒頓)
// 必定抽；漩渦威壓(洛奇亞)/惡作劇之心(龍捲雲)50%機率抽，惡作劇之心沒抽到改成下次攻擊+20。
// 跟pokemon_battle.html的同名機制共用同一份config（各自的TRAINERS/POKEMON資料是分開複製的，
// 這個小table沒必要跨檔案共用，直接各自宣告一份）
const TURN_START_DRAW_ABILITY = {
  'hadron-engine':   { cardId: 'lightning-dash' },
  'crimson-pulse':   { cardId: 'breakthrough' },
  'vortex-pressure': { cardId: 'water-aegis',    chance: 0.5 },
  'prankster-heart': { cardId: 'psychic-disrupt', chance: 0.5, elseAtkBonus: 20 },
};
function rollTurnStartAbilityDrawSrv(poke, role, G) {
  const cfg = poke?.ability && TURN_START_DRAW_ABILITY[poke.ability.id];
  if (!cfg || isAbilitySealedSrv(role, G)) return;
  if (cfg.chance != null && Math.random() >= cfg.chance) {
    if (cfg.elseAtkBonus) G[`${role}Buff`].atkBonus = cfg.elseAtkBonus;
    return;
  }
  const card = TRAINERS.find(c => c.id === cfg.cardId);
  if (card) G[`${role}Hand`].push({ ...card });
}

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
    p1StandbyGuard: false, p2StandbyGuard: false,
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
  // 2026-08-14修正：先後攻onEnter特性發動順序錯誤——不論擲硬幣結果是誰先攻(firstTurn)，
  // 這裡原本永遠是「p1先、p2後」寫死的固定順序。特性發動順序在某些情境下有意義（例如兩邊
  // 都是onEnter切換場地的特性，最後一個發動的才是真正生效的場地），應該要「先攻的玩家先發動」，
  // 不是「p1永遠先發動」——改成依firstTurn動態決定順序。
  const secondTurn = firstTurn === 'p1' ? 'p2' : 'p1';
  triggerOnEnterSrv(G[`${firstTurn}Deck`][0], firstTurn, G, startLog);
  triggerOnEnterSrv(G[`${secondTurn}Deck`][0], secondTurn, G, startLog);
  return G;
}

/* ═══════════════════════════════════════════
   ACCOUNTS: password hashing + player pool
═══════════════════════════════════════════ */
// 2026-07-30 review發現：scryptSync是CPU密集的同步呼叫(數十ms)，Node是單執行緒，
// 註冊/登入/改密碼當下會整個卡住event loop，連帶讓所有正在連線對戰的WebSocket訊息都delay——
// 改用非同步版本(util.promisify包crypto.scrypt)，讓密碼雜湊改到背景執行緒跑，不擋住其他連線。
const scryptAsync = util.promisify(crypto.scrypt);
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `${salt}:${hash}`;
}
async function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const candidate = await scryptAsync(password, salt, 64);
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
  // 逆風補償觸發時drawForRole()會在G上設一次性的comebackTriggeredRole——這裡統一promote成
  // 獨立的msg欄位給client播cutscene，並從G刪掉，這樣不會被後續跟這次事件無關的state同步誤重播
  if (msg.state && msg.state.comebackTriggeredRole) {
    msg.comebackTriggered = msg.state.comebackTriggeredRole;
    delete msg.state.comebackTriggeredRole;
  }
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
    const passwordHash = await hashPassword(password);
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
    if (!rows.length || !(await verifyPassword(password, rows[0].password_hash))) {
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
              fish_tank_pos_x, fish_tank_pos_y, fish_dex_pos_x, fish_dex_pos_y,
              display_poke1_id, display_poke2_id, display_poke3_id,
              poke_display1_pos_x, poke_display1_pos_y, poke_display2_pos_x, poke_display2_pos_y,
              poke_display3_pos_x, poke_display3_pos_y,
              poke_display1_flip, poke_display2_flip, poke_display3_flip,
              display_bird_id, birdcage_pos_x, birdcage_pos_y
       FROM pets WHERE user_id = $1`, [req.user.id]
    );
    const { rows: badgeRows } = await pool.query('SELECT badge_id, pos_x, pos_y FROM user_badges WHERE user_id = $1', [req.user.id]);
    const badges = badgeRows.filter(r => BADGES[r.badge_id]).map(r => ({ id: r.badge_id, ...BADGES[r.badge_id], x: r.pos_x, y: r.pos_y }));
    if (!rows.length) return res.json({ pet: null, badges });
    const { rows: decorRows } = await pool.query('SELECT id, item_id, pos_x, pos_y, scale FROM pet_decorations WHERE user_id = $1', [req.user.id]);
    const decorations = decorRows.map(r => ({ id: r.id, itemId: r.item_id, x: r.pos_x, y: r.pos_y, scale: r.scale }));
    const hunger = await decayHunger(req.user.id);
    // 第二隻寵物（2026-08-10新增）：只需要species_id給左側切換鈕顯示牠是誰，好感度/飢餓值
    // 要切換過去才會讀（見/api/pet/switch），這裡不用先算decayHunger，省一次沒必要的UPDATE
    const { rows: benchRows } = await pool.query('SELECT species_id FROM pet_bench WHERE user_id = $1', [req.user.id]);
    const benchSpeciesId = benchRows[0]?.species_id ?? null;
    const { rows: fishRows } = await pool.query(
      'SELECT id, fish_type, caught_at, is_favorite FROM pet_fish WHERE user_id = $1 ORDER BY caught_at DESC', [req.user.id]
    );
    const fish = fishRows.map(r => ({ id: r.id, fishType: r.fish_type, caughtAt: r.caught_at, isFavorite: r.is_favorite, ...FISH_TYPES[r.fish_type] }));
    const displayFish = rows[0].display_fish_id ? (fish.find(f => f.id === rows[0].display_fish_id) || null) : null;
    const { rows: birdRows } = await pool.query(
      'SELECT id, bird_type, caught_at, is_favorite FROM pet_birds WHERE user_id = $1 ORDER BY caught_at DESC', [req.user.id]
    );
    const birds = birdRows.map(r => ({ id: r.id, birdType: r.bird_type, caughtAt: r.caught_at, isFavorite: r.is_favorite, ...BIRD_TYPES[r.bird_type] }));
    const displayBird = rows[0].display_bird_id ? (birds.find(b => b.id === rows[0].display_bird_id) || null) : null;
    const balls = { ballNormal: rows[0].ball_normal, ballGreat: rows[0].ball_great, ballUltra: rows[0].ball_ultra };
    const fishTankPos = rows[0].fish_tank_pos_x != null ? { x: rows[0].fish_tank_pos_x, y: rows[0].fish_tank_pos_y } : null;
    const fishDexPos = rows[0].fish_dex_pos_x != null ? { x: rows[0].fish_dex_pos_x, y: rows[0].fish_dex_pos_y } : null;
    const birdcagePos = rows[0].birdcage_pos_x != null ? { x: rows[0].birdcage_pos_x, y: rows[0].birdcage_pos_y } : null;
    const pokeDisplayIds = [rows[0].display_poke1_id, rows[0].display_poke2_id, rows[0].display_poke3_id];
    const pokeDisplayPos = [
      rows[0].poke_display1_pos_x != null ? { x: rows[0].poke_display1_pos_x, y: rows[0].poke_display1_pos_y } : null,
      rows[0].poke_display2_pos_x != null ? { x: rows[0].poke_display2_pos_x, y: rows[0].poke_display2_pos_y } : null,
      rows[0].poke_display3_pos_x != null ? { x: rows[0].poke_display3_pos_x, y: rows[0].poke_display3_pos_y } : null,
    ];
    const pokeDisplayFlipped = [rows[0].poke_display1_flip, rows[0].poke_display2_flip, rows[0].poke_display3_flip];
    res.json({
      pet: { speciesId: rows[0].species_id, happiness: rows[0].happiness, coins: rows[0].coins, hunger, ...balls, fishTankPos, fishDexPos, birdcagePos, pokeDisplayIds, pokeDisplayPos, pokeDisplayFlipped, benchSpeciesId },
      badges, decorations, fish, displayFish, birds, displayBird,
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

/* ── Pocket TCG 抽卡包收藏系統（2026-08-05新增）──
   卡片池不需要登入就能看（組牌介面/收藏頁都要用），開包/收藏/牌組管理需要登入——
   訪客走完全不同的路徑（client端本地隨機100張存localStorage，看不到這幾支API）。 */
app.get('/api/pocket/cards', (req, res) => {
  res.json({ cards: POCKET_CARDS });
});
// 2026-08-06新增：開包/圖鑑選版本用的系列清單（id/name/cardCount），不含卡片本體資料
app.get('/api/pocket/sets', (req, res) => {
  res.json({ sets: POCKET_SETS });
});

const POCKET_PACK_WEIGHT = { 'One Diamond': 100, 'Two Diamond': 60, 'Three Diamond': 30, 'Four Diamond': 12, 'None': 50 };
const POCKET_CHASE_WEIGHT = { 'One Star': 20, 'One Shiny': 12, 'Two Star': 10, 'Two Shiny': 6, 'Three Star': 3, 'Crown': 1 };
function pocketWeightedPick(pool, weightFn) {
  const total = pool.reduce((s, c) => s + weightFn(c), 0);
  let r = Math.random() * total;
  for (const c of pool) {
    r -= weightFn(c);
    if (r <= 0) return c;
  }
  return pool[pool.length - 1];
}
// 2026-08-06改版：原本只有A1一個系列，卡包池是單一全域陣列；現在每個系列各自開自己的包
// （真實遊戲的包也是照系列分開賣，不會A1的包抽到B2a的卡），改成依系列預先分組好基礎池/
// 追逐池，開包時依玩家選的setId查表，避免每次骰都重新掃描全部2480張卡。
// Promo-A（P-A-xxx）這7張是所有玩家本來就直接擁有的通用卡（見POCKET_PROMO_A_IDS/
// pocketEnsurePromoACards），不該出現在開包池——抽到只會是「浪費一包」的體驗，玩家早就有了。
const POCKET_PACK_POOL_BY_SET = {};
const POCKET_CHASE_POOL_BY_SET = {};
for (const s of POCKET_SETS) {
  POCKET_PACK_POOL_BY_SET[s.id] = POCKET_CARDS_BASE.filter(c => c.set === s.id && !c.id.startsWith('P-A-'));
  POCKET_CHASE_POOL_BY_SET[s.id] = POCKET_CHASE_CARDS.filter(c => c.set === s.id);
}
// 每張卡獨立骰：95%從該系列基礎卡池（依鑽石數加權，普卡機率高）、5%從該系列2星以上「追逐卡池」抽
// （追逐卡池內部再依星等加權，Crown最稀有）。5張/包，平均每包0.25張追逐卡，約每4包抽到1張。
// 系列本身沒有追逐卡（例如卡片全部都是基礎鑽石等級）時，5%那球會自動退回基礎池，不會抽出undefined。
function pocketRollPackCard(setId) {
  const chasePool = POCKET_CHASE_POOL_BY_SET[setId] || [];
  const basePool = POCKET_PACK_POOL_BY_SET[setId] || [];
  if (chasePool.length && Math.random() < 0.05) return pocketWeightedPick(chasePool, c => POCKET_CHASE_WEIGHT[c.rarity] || 1).id;
  return pocketWeightedPick(basePool, c => POCKET_PACK_WEIGHT[c.rarity] || 20).id;
}
// 保底機制（2026-08-06新增）：連續100包都沒抽到2星以上卡片時，第100包強制保底出1張。
// pityCounter是「距離上次抽到2星以上卡片，已經開了幾包」的計數，存在pets.pocket_pity_counter，
// 每包結算一次：這包本來就抽到2星以上就直接歸零；沒抽到但計數滿100就強制把其中一個卡槽換成
// 保底卡（歸零）；兩者都沒發生就正常+1往下累積。回傳新的counter讓呼叫端接力往下傳（同一次
// 開包請求可能連續開好幾包，例如10連抽），不直接寫DB——DB只在整個請求結束時寫一次。
// 2026-08-06：保底計數是玩家帳號全域共用（不分系列），不是「每系列各自計100包」——玩家
// 選哪個系列開包不影響保底進度的累積，比較貼近玩家對「保底」的直覺理解（開好開滿都算數）。
function pocketRollPackWithPity(setId, pityCounter) {
  const cardIds = Array.from({ length: 5 }, () => pocketRollPackCard(setId));
  const hasHighRarity = cardIds.some(id => POCKET_HIGH_RARITIES.has(POCKET_CARDS_BY_ID[id]?.rarity));
  let counter = pityCounter + 1;
  let pityTriggered = false;
  const chasePool = POCKET_CHASE_POOL_BY_SET[setId] || [];
  if (!hasHighRarity && counter >= 100 && chasePool.length) {
    cardIds[cardIds.length - 1] = pocketWeightedPick(chasePool, c => POCKET_CHASE_WEIGHT[c.rarity] || 1).id;
    pityTriggered = true;
  }
  if (hasHighRarity || pityTriggered) counter = 0;
  return { cardIds, pityTriggered, counter };
}

// 2026-08-06改版：原本只curate了7張最常用的Promo-A卡自動發放，其餘93張完全沒有取得管道
// （不在開包池、也沒自動發），使用者要求維持「Promo-A整組都直接擁有」的設計——改成動態
// 從卡池撈出全部P-A系列的id（目前100張，以後TCGdex的P-A系列擴增也會自動跟著長，不用
// 每次手動加id）。全部Promo-A卡不用抽，所有玩家本來就直接擁有——用「讀收藏時lazy補發」
// 而不是只在註冊時發一次，這樣既有帳號（在這個機制上線前就註冊的）下次讀收藏也會自動補到，
// 不用額外寫一次性migration去回填舊帳號。ON CONFLICT DO NOTHING讓這個函式可以放心重複呼叫。
const POCKET_PROMO_A_IDS = POCKET_CARDS.filter(c => c.set === 'P-A').map(c => c.id);
async function pocketEnsurePromoACards(userId) {
  for (const cardId of POCKET_PROMO_A_IDS) {
    await pool.query(
      `INSERT INTO pocket_collection (user_id, card_id, count) VALUES ($1, $2, 2)
       ON CONFLICT (user_id, card_id) DO UPDATE SET count = GREATEST(pocket_collection.count, 2)`,
      [userId, cardId]
    );
  }
}

app.get('/api/pocket/collection', requireAuth, async (req, res) => {
  try {
    await pocketEnsurePromoACards(req.user.id);
    const { rows } = await pool.query('SELECT card_id, count FROM pocket_collection WHERE user_id = $1 AND count > 0', [req.user.id]);
    const { rows: shardRows } = await pool.query('SELECT pocket_shards FROM pets WHERE user_id = $1', [req.user.id]);
    res.json({ collection: rows.map(r => ({ cardId: r.card_id, count: r.count })), shards: shardRows[0]?.pocket_shards ?? 0 });
  } catch (e) {
    console.error('pocket collection fetch error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

// 卡牌分解取得的晶鑽數量 / 合成消耗的晶鑽數量，都依稀有度分級。Crown故意不列在
// SYNTHESIZE表裡——皇冠卡只能靠開包抽到，不能用晶鑽合成取得（使用者明確要求的限制）。
// 2026-08-06調高2星以上的分解回饋——原本100/250/500跟合成成本(800/2000)比起來太摳，
// 拆3張重複的2星卡才勉強湊得到合成1張沒有的2星卡，使用者覺得應該要更慷慨一點
// 2026-08-06新增系列引入了One Star/Shiny這幾種原本沒有的星等，補進兩張分級表（沿用既有
// 數值級距的比例往上外推，跟開包機率權重POCKET_CHASE_WEIGHT的稀有度排序一致）
const POCKET_DISMANTLE_SHARDS = { 'One Diamond': 5, 'Two Diamond': 10, 'Three Diamond': 20, 'Four Diamond': 40, 'One Star': 150, 'One Shiny': 200, 'Two Star': 300, 'Two Shiny': 500, 'Three Star': 800, 'Crown': 2000 };
const POCKET_SYNTHESIZE_COST = { 'One Diamond': 20, 'Two Diamond': 50, 'Three Diamond': 120, 'Four Diamond': 300, 'One Star': 500, 'One Shiny': 650, 'Two Star': 800, 'Two Shiny': 1400, 'Three Star': 2000 };

app.post('/api/pocket/dismantle', requireAuth, async (req, res) => {
  const cardId = req.body?.cardId;
  const count = Math.max(1, Math.min(99, parseInt(req.body?.count, 10) || 1));
  const card = POCKET_CARDS_BY_ID[cardId];
  if (!card) return res.status(400).json({ error: 'invalid_card' });
  // Promo-A每次讀收藏都會被pocketEnsurePromoACards補回2張（見上面註解）——如果讓這7張
  // 可以分解，會變成「分解→下次讀收藏自動補回→再分解」的無限晶鑽刷法，必須整類擋掉
  if (POCKET_PROMO_A_IDS.includes(cardId)) return res.status(400).json({ error: 'cannot_dismantle_promo', message: '這張卡本來就直接擁有，不能分解' });
  const shardsPerCard = POCKET_DISMANTLE_SHARDS[card.rarity] || 5;
  try {
    const { rowCount } = await pool.query(
      'UPDATE pocket_collection SET count = count - $1 WHERE user_id = $2 AND card_id = $3 AND count >= $1',
      [count, req.user.id, cardId]
    );
    if (!rowCount) return res.status(400).json({ error: 'not_enough_copies', message: '擁有的數量不足，無法分解這麼多張' });
    const gained = shardsPerCard * count;
    const { rows } = await pool.query('UPDATE pets SET pocket_shards = pocket_shards + $1 WHERE user_id = $2 RETURNING pocket_shards', [gained, req.user.id]);
    res.json({ gained, shards: rows[0]?.pocket_shards ?? 0 });
  } catch (e) {
    console.error('pocket dismantle error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

// 2026-08-06新增一鍵分解：把所有擁有數超過2張的卡（Promo-A排除）分解到剩2張，一次結算晶鑽總數。
// 「留2張」而不是留1張——牌組規則同名卡最多放2張，留2張代表「保留組牌所需的份數，分解真正多餘的」。
app.post('/api/pocket/dismantle-all', requireAuth, async (req, res) => {
  const KEEP = 2;
  try {
    const { rows } = await pool.query(
      `SELECT card_id, count FROM pocket_collection WHERE user_id = $1 AND count > $2`,
      [req.user.id, KEEP]
    );
    const eligible = rows.filter(r => !POCKET_PROMO_A_IDS.includes(r.card_id) && POCKET_CARDS_BY_ID[r.card_id]);
    if (!eligible.length) return res.json({ gained: 0, cardsDismantled: 0, shards: null });
    let totalGained = 0;
    for (const r of eligible) {
      const card = POCKET_CARDS_BY_ID[r.card_id];
      const extra = r.count - KEEP;
      const shardsPerCard = POCKET_DISMANTLE_SHARDS[card.rarity] || 5;
      totalGained += shardsPerCard * extra;
      await pool.query('UPDATE pocket_collection SET count = $1 WHERE user_id = $2 AND card_id = $3', [KEEP, req.user.id, r.card_id]);
    }
    const { rows: shardRows } = await pool.query('UPDATE pets SET pocket_shards = pocket_shards + $1 WHERE user_id = $2 RETURNING pocket_shards', [totalGained, req.user.id]);
    res.json({ gained: totalGained, cardsDismantled: eligible.length, shards: shardRows[0]?.pocket_shards ?? 0 });
  } catch (e) {
    console.error('pocket dismantle-all error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pocket/synthesize', requireAuth, async (req, res) => {
  const cardId = req.body?.cardId;
  const card = POCKET_CARDS_BY_ID[cardId];
  if (!card) return res.status(400).json({ error: 'invalid_card' });
  if (card.rarity === 'Crown') return res.status(400).json({ error: 'crown_not_synthesizable', message: '皇冠卡不能透過合成取得，只能靠開包抽到' });
  if (POCKET_PROMO_A_IDS.includes(cardId)) return res.status(400).json({ error: 'already_owned', message: '這張卡本來就直接擁有' });
  const cost = POCKET_SYNTHESIZE_COST[card.rarity];
  if (!cost) return res.status(400).json({ error: 'not_synthesizable' });
  try {
    // 只給「完全沒有的卡」合成——不是拿晶鑽無限刷同一張卡的複本，這裡故意不做count>=1的加購版本
    const { rows: ownedRows } = await pool.query('SELECT count FROM pocket_collection WHERE user_id = $1 AND card_id = $2', [req.user.id, cardId]);
    if ((ownedRows[0]?.count || 0) > 0) return res.status(400).json({ error: 'already_owned', message: '已經擁有這張卡了，合成只能用來補齊尚未獲得的卡' });
    const { rowCount } = await pool.query('UPDATE pets SET pocket_shards = pocket_shards - $1 WHERE user_id = $2 AND pocket_shards >= $1', [cost, req.user.id]);
    if (!rowCount) return res.status(400).json({ error: 'insufficient_shards', message: `晶鑽不足，需要 ${cost} 顆` });
    await pool.query(
      `INSERT INTO pocket_collection (user_id, card_id, count) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, card_id) DO UPDATE SET count = pocket_collection.count + 1`,
      [req.user.id, cardId]
    );
    const { rows } = await pool.query('SELECT pocket_shards FROM pets WHERE user_id = $1', [req.user.id]);
    res.json({ spent: cost, shards: rows[0]?.pocket_shards ?? 0 });
  } catch (e) {
    console.error('pocket synthesize error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pocket/open-pack', requireAuth, async (req, res) => {
  const PACK_COST = 50;
  // 2026-08-06新增10連抽：目前只開放1或10兩種數量，其餘一律當成單抽處理，避免client亂傳
  // 巨量count對DB造成過大負擔（例如count=99999）。
  const count = req.body?.count === 10 ? 10 : 1;
  // 2026-08-06新增選版本開包：沒帶set或帶了不存在的系列一律退回A1（最初也是唯一舊資料能保證
  // 一定有卡的系列），不會因為client傳壞資料就整包開不出東西
  // P-A（Promo-A）不能開包——那組卡全部直接發放，包池本身就是空的（見POCKET_PACK_POOL_BY_SET
  // 排除P-A-開頭id的邏輯），選到P-A一律退回A1，避免真的打進pocketRollPackCard抽到空池出錯
  const requestedSet = req.body?.set;
  const setId = POCKET_SETS.some(s => s.id === requestedSet) && requestedSet !== 'P-A' ? requestedSet : 'A1';
  try {
    // 金幣/每日免費額度都活在pets這張表——如果玩家還沒去「我的寶可夢」選過初始寶可夢，
    // 根本沒有pets列，下面的UPDATE會直接match 0 rows，錯誤訊息會被誤判成「金幣不足」
    // （其實是完全不相關的兩件事）。先擋在這裡給明確提示，不要讓玩家看著「金幣不足」卻
    // 摸不著頭緒（他們可能連coins是什麼都還沒看過）。
    const { rows: petCheck } = await pool.query('SELECT pocket_pity_counter FROM pets WHERE user_id = $1', [req.user.id]);
    if (!petCheck.length) return res.status(400).json({ error: 'no_pet', message: '請先到「我的寶可夢」選一隻起始寶可夢，開包用的金幣/每日免費額度都是共用同一套系統' });
    let pity = petCheck[0].pocket_pity_counter || 0;
    const pulledIds = [];
    let freeUsedCount = 0, paidUsedCount = 0, pityHits = 0;
    // 10連抽逐包結算（沿用單抽同一套atomic免費額度/扣款邏輯），金幣不夠時提早停止而不是整批擋下——
    // 玩家已經付出的免費額度/金幣一律照樣發卡，只是實際開包數會少於要求的10包，client端要處理這個落差
    for (let i = 0; i < count; i++) {
      const { rowCount: freeHit } = await pool.query(
        `UPDATE pets SET
           pocket_free_packs_used = CASE WHEN pocket_free_packs_date IS NULL OR pocket_free_packs_date < CURRENT_DATE THEN 1 ELSE pocket_free_packs_used + 1 END,
           pocket_free_packs_date = CURRENT_DATE
         WHERE user_id = $1
           AND (pocket_free_packs_date IS NULL OR pocket_free_packs_date < CURRENT_DATE OR pocket_free_packs_used < 5)`,
        [req.user.id]
      );
      if (freeHit > 0) {
        freeUsedCount++;
      } else {
        const { rowCount: paidHit } = await pool.query(
          'UPDATE pets SET coins = coins - $1 WHERE user_id = $2 AND coins >= $1', [PACK_COST, req.user.id]
        );
        if (!paidHit) {
          if (i === 0) return res.status(400).json({ error: 'insufficient_coins', message: '今日免費開包額度已用完，金幣也不足50' });
          break; // 至少開成功了1包，把已經拿到的卡正常回傳，讓client顯示「只開了N包」
        }
        paidUsedCount++;
      }
      const { cardIds, pityTriggered, counter } = pocketRollPackWithPity(setId, pity);
      pity = counter;
      if (pityTriggered) pityHits++;
      pulledIds.push(...cardIds);
    }
    for (const cardId of pulledIds) {
      await pool.query(
        `INSERT INTO pocket_collection (user_id, card_id, count) VALUES ($1, $2, 1)
         ON CONFLICT (user_id, card_id) DO UPDATE SET count = pocket_collection.count + 1`,
        [req.user.id, cardId]
      );
    }
    await pool.query('UPDATE pets SET pocket_pity_counter = $1 WHERE user_id = $2', [pity, req.user.id]);
    const { rows } = await pool.query('SELECT coins, pocket_free_packs_used FROM pets WHERE user_id = $1', [req.user.id]);
    res.json({
      cards: pulledIds.map(id => POCKET_CARDS_BY_ID[id]),
      set: setId,
      packsOpened: freeUsedCount + paidUsedCount, usedFree: freeUsedCount > 0, freeUsedCount, paidUsedCount,
      pityHits, pityCounter: pity,
      coins: rows[0]?.coins, freePacksUsedToday: rows[0]?.pocket_free_packs_used,
    });
  } catch (e) {
    console.error('pocket open-pack error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

// 驗證要存的牌組是不是真的能組出來：20張、同張卡最多2張、擁有量要夠、至少1張基礎寶可夢——
// 跟validatePocketDeck（對戰用，只驗證卡池存不存在+基本規則）分開，這裡多一層「擁有量」檢查
async function pocketValidateOwnedDeck(userId, deckIds) {
  const basicErr = validatePocketDeck(deckIds);
  if (basicErr) return basicErr;
  const { rows } = await pool.query('SELECT card_id, count FROM pocket_collection WHERE user_id = $1', [userId]);
  const owned = Object.fromEntries(rows.map(r => [r.card_id, r.count]));
  const needed = {};
  for (const id of deckIds) needed[id] = (needed[id] || 0) + 1;
  for (const id in needed) {
    if ((owned[id] || 0) < needed[id]) {
      return `${POCKET_CARDS_BY_ID[id]?.name || id} 擁有數量不足（需要${needed[id]}張，只有${owned[id] || 0}張）`;
    }
  }
  return null;
}

app.get('/api/pocket/decks', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, card_ids, energy_types, updated_at FROM pocket_decks WHERE user_id = $1 ORDER BY updated_at DESC', [req.user.id]);
    res.json({ decks: rows.map(r => ({ id: r.id, name: r.name, cardIds: r.card_ids, energyTypes: r.energy_types || null, updatedAt: r.updated_at })) });
  } catch (e) {
    console.error('pocket decks fetch error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pocket/decks', requireAuth, async (req, res) => {
  try {
    const { name, cardIds } = req.body || {};
    const err = await pocketValidateOwnedDeck(req.user.id, cardIds);
    if (err) return res.status(400).json({ error: 'invalid_deck', message: err });
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM pocket_decks WHERE user_id = $1', [req.user.id]);
    if (Number(countRows[0].count) >= 20) return res.status(400).json({ error: 'deck_limit', message: '最多只能儲存 20 副牌組' });
    const deckName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 30) : '未命名牌組';
    const energyTypes = pocketValidateEnergyTypes(req.body?.energyTypes);
    const { rows } = await pool.query(
      'INSERT INTO pocket_decks (user_id, name, card_ids, energy_types) VALUES ($1, $2, $3, $4) RETURNING id, name, card_ids, energy_types, updated_at',
      [req.user.id, deckName, cardIds, energyTypes]
    );
    res.json({ deck: { id: rows[0].id, name: rows[0].name, cardIds: rows[0].card_ids, energyTypes: rows[0].energy_types || null, updatedAt: rows[0].updated_at } });
  } catch (e) {
    console.error('pocket deck create error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.put('/api/pocket/decks/:id', requireAuth, async (req, res) => {
  try {
    const { name, cardIds } = req.body || {};
    const err = await pocketValidateOwnedDeck(req.user.id, cardIds);
    if (err) return res.status(400).json({ error: 'invalid_deck', message: err });
    const deckName = (typeof name === 'string' && name.trim()) ? name.trim().slice(0, 30) : '未命名牌組';
    const energyTypes = pocketValidateEnergyTypes(req.body?.energyTypes);
    const { rows, rowCount } = await pool.query(
      `UPDATE pocket_decks SET name = $1, card_ids = $2, energy_types = $3, updated_at = NOW()
       WHERE id = $4 AND user_id = $5 RETURNING id, name, card_ids, energy_types, updated_at`,
      [deckName, cardIds, energyTypes, req.params.id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ deck: { id: rows[0].id, name: rows[0].name, cardIds: rows[0].card_ids, energyTypes: rows[0].energy_types || null, updatedAt: rows[0].updated_at } });
  } catch (e) {
    console.error('pocket deck update error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.delete('/api/pocket/decks/:id', requireAuth, async (req, res) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM pocket_decks WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('pocket deck delete error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pet/buy', requireAuth, async (req, res) => {
  const itemId = req.body?.itemId;
  const item = SHOP_ITEMS[itemId];
  if (!item) return res.status(400).json({ error: 'invalid_item' });
  if (item.notForSale) return res.status(400).json({ error: 'not_for_sale' });
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
    // 2026-07-23：房間裝飾改成可以買多份、同時擺多個（跟球一樣沒有「已擁有就不能再買」的限制），
    // 拿掉原本的already_owned擋下，INSERT一律新增一列（pet_decorations現在是SERIAL id當PK，
    // 不再是(user_id,item_id)複合PK，同一種裝飾可以有很多列）。RETURNING id讓前端能記住這一份
    // 的實體id，之後擺放/收回/縮放都要靠這個id定址，不能再用item_id（itemId不再唯一）。
    const coins = coinRows[0].coins - item.price;
    await pool.query('UPDATE pets SET coins = $1 WHERE user_id = $2', [coins, req.user.id]);
    const { rows: insRows } = await pool.query(
      'INSERT INTO pet_decorations (user_id, item_id) VALUES ($1, $2) RETURNING id', [req.user.id, itemId]
    );
    res.status(201).json({ coins, decorId: insRows[0].id });
  } catch (e) {
    console.error('pet buy error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 精靈球變賣——半價換回金幣（跟買價同一套SHOP_ITEMS.price，不另存sellPrice欄位）。
   跟/api/pet/buy同樣改成單一原子UPDATE（球數量夠不夠直接放WHERE子句判斷)，避免buy端點
   當初踩過的併發race condition（兩個請求都讀到同一個舊值，其中一次效果被覆蓋消失）。 */
app.post('/api/pet/sell-ball', requireAuth, async (req, res) => {
  const itemId = req.body?.itemId;
  const item = SHOP_ITEMS[itemId];
  if (!item || item.category !== 'ball') return res.status(400).json({ error: 'invalid_item' });
  // 半價無條件至少賣1金幣——一般球價格只有1，floor(1/2)本來會是0，等於白送對方一顆球換不到錢
  const sellPrice = Math.max(1, Math.floor(item.price / 2));
  try {
    const { rows } = await pool.query(
      `UPDATE pets SET coins = coins + $1, ${item.ballField} = ${item.ballField} - 1
       WHERE user_id = $2 AND ${item.ballField} >= 1
       RETURNING coins, ${item.ballField} AS count`,
      [sellPrice, req.user.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'not_enough_balls' });
    res.json({ coins: rows[0].coins, ballField: item.ballField, count: rows[0].count, coinsAwarded: sellPrice });
  } catch (e) {
    console.error('pet sell-ball error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

// 2026-08-04應使用者要求新增「一鍵賣出」——原本sell-ball一次只賣1顆，球數量多時要點很多次。
// SET子句裡的coins/${item.ballField}都是同一條UPDATE語句內對「更新前」的row值求值（Postgres標準行為，
// 不是循序執行），所以coins可以直接用舊的ballField算出賣出總額，不用先查詢一次再算，天生原子操作。
app.post('/api/pet/sell-ball-all', requireAuth, async (req, res) => {
  const itemId = req.body?.itemId;
  const item = SHOP_ITEMS[itemId];
  if (!item || item.category !== 'ball') return res.status(400).json({ error: 'invalid_item' });
  const sellPrice = Math.max(1, Math.floor(item.price / 2));
  try {
    const { rows } = await pool.query(
      `UPDATE pets SET coins = coins + (${item.ballField} * $1), ${item.ballField} = 0
       WHERE user_id = $2 AND ${item.ballField} >= 1
       RETURNING coins, ${item.ballField} AS count`,
      [sellPrice, req.user.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'not_enough_balls' });
    res.json({ coins: rows[0].coins, ballField: item.ballField, count: rows[0].count });
  } catch (e) {
    console.error('pet sell-ball-all error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 單人模式「冠軍挑戰模式」打贏三關後核發冠軍獎盃——只驗證登入+尚未領過，不重新驗證整場戰鬥
   （單人模式本來就完全跑在client端，沒有伺服器連線，這裡刻意比照那個既有信任模型，不做PvP
   等級的server-authoritative重寫）。只能領一次：已經有這筆pet_decorations就直接回alreadyOwned，
   不重複insert、不再扣錢（免費道具，price:0只是防呆，這裡本來就不走扣款流程）。 */
app.post('/api/pet/claim-champion-trophy', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT 1 FROM pets WHERE user_id = $1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'no_pet' });
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM pet_decorations WHERE user_id = $1 AND item_id = 'trophy-champion'", [req.user.id]
    );
    if (existing.length) return res.json({ alreadyOwned: true });
    const { rows: insRows } = await pool.query(
      "INSERT INTO pet_decorations (user_id, item_id) VALUES ($1, 'trophy-champion') RETURNING id", [req.user.id]
    );
    res.status(201).json({ alreadyOwned: false, decorId: insRows[0].id });
  } catch (e) {
    console.error('claim champion trophy error:', e.message);
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
    } else {
      // 2026-07-29應使用者要求：隊伍原本上限10隻，改為無上限，直接新增不用再走放生流程
      const newIds = [...currentIds, pokemonId];
      await client.query(
        `INSERT INTO teams (user_id, pokemon_ids) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET pokemon_ids = $2, updated_at = NOW()`,
        [req.user.id, newIds]
      );
      responsePayload = { caught: true, added: true, pokemonId, name: wild.name, ...ballCounts };
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
    // 放生的這隻如果剛好正在寶可夢展示台上，展示欄位沒有外鍵可以自動清空（不像魚缸的
    // display_fish_id有ON DELETE SET NULL），手動清掉避免展示台留著已經不在隊伍裡的寶可夢
    await pool.query(
      `UPDATE pets SET
         display_poke1_id = CASE WHEN display_poke1_id = $1 THEN NULL ELSE display_poke1_id END,
         display_poke2_id = CASE WHEN display_poke2_id = $1 THEN NULL ELSE display_poke2_id END,
         display_poke3_id = CASE WHEN display_poke3_id = $1 THEN NULL ELSE display_poke3_id END
       WHERE user_id = $2`,
      [releasePokemonId, req.user.id]
    );
    pendingCatchReleases.delete(req.user.id);
    res.json({ released: true, releasedPokemonId: releasePokemonId, addedPokemonId: newPokemonId });
  } catch (e) {
    console.error('pet catch resolve-release error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 捕捉到的寶可夢變賣——換算成金幣的價值刻意跟「抓到重複寶可夢」的補償金（300）用同一個數字，
   維持「這隻寶可夢換算成多少錢」在遊戲內只有一種價值，不會因為是自動觸發還是玩家手動賣掉而不同。
   跟resolve-release共用同一條安全檢查：賣掉後三個血量區間（200-249／250-309／310+）都要還有
   至少1隻，不然玩家會卡在單人模式/PvP選隊畫面湊不出合法隊伍。整段包成交易，跟catch/throw
   同樣的理由——選隊/扣錢/清展示台要嘛一起生效要嘛都不生效，不留半套狀態。 */
const SELL_POKEMON_REWARD = 300;
app.post('/api/pet/team/sell', requireAuth, async (req, res) => {
  const pokemonId = Number(req.body?.pokemonId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: teamRows } = await client.query(
      'SELECT pokemon_ids FROM teams WHERE user_id = $1 FOR UPDATE', [req.user.id]
    );
    const currentIds = teamRows[0]?.pokemon_ids || [];
    if (!currentIds.includes(pokemonId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'not_in_team' });
    }
    const newIds = currentIds.filter(id => id !== pokemonId);
    const newMons = newIds.map(id => POKEMON.find(p => p.id === id)).filter(Boolean);
    if (new Set(newMons.map(p => hpBand(p.hp))).size !== 3) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'would_break_hp_bands' });
    }
    await client.query(
      'UPDATE teams SET pokemon_ids = $1, updated_at = NOW() WHERE user_id = $2', [newIds, req.user.id]
    );
    // 賣掉的這隻如果剛好正在展示台上，手動清空——跟resolve-release同樣的理由，display_pokeN_id
    // 沒有外鍵可以自動處理（不像魚缸的display_fish_id有ON DELETE SET NULL）
    const { rows: petRows } = await client.query(
      `UPDATE pets SET coins = coins + $1,
         display_poke1_id = CASE WHEN display_poke1_id = $2 THEN NULL ELSE display_poke1_id END,
         display_poke2_id = CASE WHEN display_poke2_id = $2 THEN NULL ELSE display_poke2_id END,
         display_poke3_id = CASE WHEN display_poke3_id = $2 THEN NULL ELSE display_poke3_id END
       WHERE user_id = $3
       RETURNING coins`,
      [SELL_POKEMON_REWARD, pokemonId, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ sold: true, soldPokemonId: pokemonId, coinsAwarded: SELL_POKEMON_REWARD, coins: petRows[0].coins });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 連線本身可能已經斷了，rollback失敗就不用管 */ }
    console.error('pet team sell error:', e.message);
    res.status(503).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

/* 玩家提早放棄（時間還沒到）——只負責清掉伺服器這邊記住的進行中encounter，讓玩家可以馬上
   開始下一次彈弓，不用等原本的30秒TTL自然過期；不是2026-07-26之前拿掉的那個「退款」端點，
   這裡完全沒有退錢邏輯，純粹只是解鎖，跟退款是兩件事（使用者要拿掉的是退款，不是「能不能
   馬上重來」）。2026-07-26應使用者回報「彈弓點放棄會出現bug」修正：拿掉退款端點時连同「通知
   伺服器結束」這個動作也一起拿掉了，導致關窗後伺服器還以為encounter在進行中，直到30秒TTL
   自然過期前，玩家重開彈弓一律被encounter_in_progress擋掉、只看到一個看不出原因的錯誤訊息。 */
app.post('/api/pet/slingshot/giveup', requireAuth, async (req, res) => {
  activeSlingshotEncounters.delete(req.user.id);
  res.json({ ok: true });
});

/* 彈弓第1步：花80金幣或5顆一般精靈球（client端二選一，body.paymentMethod指定）讓一隻鳥
   （依BIRD_TYPES的weight隨機抽）出現，開始30秒真實倒數，同時記下這隻要打中幾次才能捕捉
   成功（hitsRemaining，伺服器權威計數）。不信任client算好的餘額，SQL的WHERE條件本身就是
   權威扣款檢查——跟原本金幣那條路徑同一個寫法，球的路徑對ball_normal做一樣的事。 */
app.post('/api/pet/slingshot/encounter', requireAuth, async (req, res) => {
  const existing = activeSlingshotEncounters.get(req.user.id);
  if (existing && existing.expiresAt > Date.now()) {
    return res.status(400).json({ error: 'encounter_in_progress' });
  }
  const payWithBalls = req.body?.paymentMethod === 'balls';
  try {
    const { rows } = payWithBalls
      ? await pool.query(
          `UPDATE pets SET ball_normal = ball_normal - $1 WHERE user_id = $2 AND ball_normal >= $1 RETURNING coins, ball_normal`,
          [SLINGSHOT_BALL_COST, req.user.id]
        )
      : await pool.query(
          `UPDATE pets SET coins = coins - $1 WHERE user_id = $2 AND coins >= $1 RETURNING coins, ball_normal`,
          [SLINGSHOT_ENCOUNTER_COST, req.user.id]
        );
    if (!rows.length) {
      const { rows: existsRows } = await pool.query('SELECT 1 FROM pets WHERE user_id = $1', [req.user.id]);
      const errKey = payWithBalls ? 'not_enough_balls' : 'not_enough_coins';
      return res.status(existsRows.length ? 400 : 404).json({ error: existsRows.length ? errKey : 'no_pet' });
    }
    const birdType = rollBird();
    const bird = BIRD_TYPES[birdType];
    const expiresAt = Date.now() + SLINGSHOT_TTL_MS;
    activeSlingshotEncounters.set(req.user.id, { birdType, name: bird.name, hits: bird.hits, hitsRemaining: bird.hits, expiresAt });
    res.json({ coins: rows[0].coins, ballNormal: rows[0].ball_normal, birdType, name: bird.name, speciesId: bird.speciesId, showdownName: bird.showdownName, hits: bird.hits, hitsRemaining: bird.hits, rare: !!bird.rare, expiresAt });
  } catch (e) {
    console.error('slingshot encounter error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 彈弓第2步：client回報「命中了」（畫面碰撞判定已經在client端算完），伺服器只負責權威地扣減
   命中次數——不信任client回報「這是第幾次命中」，每次呼叫都只當作一次命中來處理。次數還沒
   歸零就代表遭遇還在進行（回傳目前剩餘次數，client據此更新血條），只有真的打滿次數那一下
   才真的寫進pet_birds收藏（跟釣魚pet_fish同一套registry-driven+discovered永久紀錄）。
   小機率讓鳥直接飛走結束遭遇（跟地面捕捉共用FIERCE_RESISTANCE_CHANCE），沒飛走的話時限不展延。 */
app.post('/api/pet/slingshot/hit', requireAuth, async (req, res) => {
  const birdType = req.body?.birdType;
  const bird = BIRD_TYPES[birdType];
  if (!bird) return res.status(400).json({ error: 'invalid_request' });

  const encounter = activeSlingshotEncounters.get(req.user.id);
  if (!encounter || encounter.birdType !== birdType || encounter.expiresAt < Date.now()) {
    return res.status(400).json({ error: 'no_active_encounter' });
  }
  activeSlingshotEncounters.delete(req.user.id); // 先認領，避免併發hit重複扣次數（跟地面捕捉throw同一個教訓）

  const hitsRemaining = encounter.hitsRemaining - 1;
  if (hitsRemaining > 0) {
    const fierce = Math.random() < FIERCE_RESISTANCE_CHANCE;
    if (!fierce) activeSlingshotEncounters.set(req.user.id, { ...encounter, hitsRemaining });
    return res.json({ caught: false, fled: fierce, hitsRemaining, hits: bird.hits });
  }

  // 打滿次數——真的捕捉成功，寫進鳥類收藏（跟pet_fish同一套：不限量、不判重複，收藏是獨立於
  // 隊伍的系列，沒有「隊伍已滿10隻」這種上限問題）
  try {
    const { rows: insertRows } = await pool.query(
      'INSERT INTO pet_birds (user_id, bird_type) VALUES ($1, $2) RETURNING id, caught_at',
      [req.user.id, birdType]
    );
    await pool.query(
      'INSERT INTO pet_birds_discovered (user_id, bird_type) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.id, birdType]
    );
    res.json({ caught: true, birdType, ...bird, rare: !!bird.rare, birdId: insertRows[0].id, caughtAt: insertRows[0].caught_at });
  } catch (e) {
    activeSlingshotEncounters.set(req.user.id, { ...encounter, hitsRemaining: 1 }); // 例外導致沒寫進去，讓玩家能再打最後一下重試
    console.error('slingshot hit error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* x/y為null代表收回道具欄；房間裝飾改成自由拖曳座標後不再有固定插槽，
   改用「同時擺放幾件」的數量上限（DECOR_PLACE_LIMIT）防止房間被塞爆——
   使用者明確要求維持上限、不要取消（見規劃討論）。座標是相對#pet-stage寬高的0~1標準化分數，
   跟setupVisitSprite()既有的placeAt(fracX,fracY)手法同一套模型。 */
app.post('/api/pet/place', requireAuth, async (req, res) => {
  // 2026-07-23：改用pet_decorations的實體id定址，不再用itemId——同一種裝飾現在可以有多份，
  // itemId不再唯一，沒辦法用它指定「是哪一份」。
  const id = Number(req.body?.id);
  let { x, y } = req.body || {};
  x = (x === null || x === undefined) ? null : Number(x);
  y = (y === null || y === undefined) ? null : Number(y);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_request' });
  if (x !== null && (Number.isNaN(x) || x < 0 || x > 1)) return res.status(400).json({ error: 'invalid_position' });
  if (y !== null && (Number.isNaN(y) || y < 0 || y > 1)) return res.status(400).json({ error: 'invalid_position' });
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM pet_decorations WHERE id = $1 AND user_id = $2', [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    if (x !== null) {
      // 排除的是「正在移動的這一份自己」（用id），不是整個item_id——同一種裝飾的其他份
      // 仍然要算進同時擺放的數量上限，跟以前「每種最多一份」時代排除整個item_id的寫法不同
      const { rows: countRows } = await pool.query(
        'SELECT COUNT(*)::int AS n FROM pet_decorations WHERE user_id = $1 AND pos_x IS NOT NULL AND id != $2',
        [req.user.id, id]
      );
      if (countRows[0].n >= DECOR_PLACE_LIMIT) return res.status(400).json({ error: 'limit_reached' });
    }
    await pool.query('UPDATE pet_decorations SET pos_x = $1, pos_y = $2 WHERE id = $3', [x, y, id]);
    res.json({});
  } catch (e) {
    console.error('pet place error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 裝潢模式下滾滾輪調整已擺放裝飾的大小。範圍0.4~2.5是前端滾輪縮放時同一組clamp邊界，
   兩邊要保持一致（伺服器這裡是最終驗證，前端只是即時視覺回饋）。 */
app.post('/api/pet/decor/scale', requireAuth, async (req, res) => {
  const id = Number(req.body?.id);
  const scale = Number(req.body?.scale);
  if (!Number.isInteger(id) || Number.isNaN(scale) || scale < 0.4 || scale > 2.5) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE pet_decorations SET scale = $1 WHERE id = $2 AND user_id = $3', [scale, id, req.user.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_owned' });
    res.json({});
  } catch (e) {
    console.error('pet decor scale error:', e.message);
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
  poke_display1: ['poke_display1_pos_x', 'poke_display1_pos_y'],
  poke_display2: ['poke_display2_pos_x', 'poke_display2_pos_y'],
  poke_display3: ['poke_display3_pos_x', 'poke_display3_pos_y'],
  birdcage: ['birdcage_pos_x', 'birdcage_pos_y'],
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

/* 寶可夢展示台——設定3個展示位其中一個要放哪隻（或null=清空）。跟魚缸的display_fish_id不同，
   teams.pokemon_ids是陣列欄位沒有資料表列可以外鍵約束，只能手動查隊伍陣列確認pokemonId
   真的在玩家目前隊伍裡，擋掉偽造不屬於自己隊伍的id。 */
app.post('/api/pet/display/set', requireAuth, async (req, res) => {
  const slot = Number(req.body?.slot);
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'invalid_slot' });
  const pokemonId = req.body?.pokemonId == null ? null : Number(req.body.pokemonId);
  try {
    if (pokemonId != null) {
      const { rows } = await pool.query('SELECT pokemon_ids FROM teams WHERE user_id = $1', [req.user.id]);
      if (!(rows[0]?.pokemon_ids || []).includes(pokemonId)) return res.status(400).json({ error: 'not_in_team' });
    }
    await pool.query(`UPDATE pets SET display_poke${slot}_id = $1 WHERE user_id = $2`, [pokemonId, req.user.id]);
    res.json({});
  } catch (e) {
    console.error('pet display set error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 展示位水平翻轉——純視覺偏好，不用驗證pokemonId，跟哪隻寶可夢在展示無關，
   翻轉狀態就算展示位目前是空的也可以先設定好（下次選寶可夢進來就直接套用）。 */
app.post('/api/pet/display/flip', requireAuth, async (req, res) => {
  const slot = Number(req.body?.slot);
  if (![1, 2, 3].includes(slot)) return res.status(400).json({ error: 'invalid_slot' });
  const flip = !!req.body?.flip;
  try {
    await pool.query(`UPDATE pets SET poke_display${slot}_flip = $1 WHERE user_id = $2`, [flip, req.user.id]);
    res.json({});
  } catch (e) {
    console.error('pet display flip error:', e.message);
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

/* 買第二隻寵物（2026-08-10新增）：花SECOND_PET_PRICE金幣，species不能跟目前顯示中的那隻重複，
   而且pet_bench已經有一列就代表額度用完了（user_id是PK，天然限制最多備用1隻，符合這次「先開放
   只能多買一隻」的範圍）。扣錢+新增備用寵物包成一個交易——要嘛都成功、要嘛都沒發生，不會出現
   「錢扣了但沒拿到寵物」的中間態。買完不會立刻上場，維持顯示原本那隻寵物，玩家自己按左側切換鈕。 */
app.post('/api/pet/buy-second', requireAuth, async (req, res) => {
  const speciesId = Number(req.body?.speciesId);
  if (!PET_SPECIES.some(s => s.id === speciesId)) {
    return res.status(400).json({ error: 'invalid_species' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: petRows } = await client.query('SELECT species_id, coins FROM pets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (!petRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no_pet' }); }
    if (petRows[0].species_id === speciesId) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'already_owned_species' }); }
    const { rows: benchRows } = await client.query('SELECT species_id FROM pet_bench WHERE user_id = $1 FOR UPDATE', [req.user.id]);
    if (benchRows.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'bench_full' }); }
    if (petRows[0].coins < SECOND_PET_PRICE) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'not_enough_coins' }); }
    const { rows: updated } = await client.query(
      'UPDATE pets SET coins = coins - $1 WHERE user_id = $2 AND coins >= $1 RETURNING coins',
      [SECOND_PET_PRICE, req.user.id]
    );
    if (!updated.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'not_enough_coins' }); }
    await client.query(
      'INSERT INTO pet_bench (user_id, species_id, happiness, hunger, last_fed_at, last_interaction_at) VALUES ($1, $2, 50, 100, NOW(), NULL)',
      [req.user.id, speciesId]
    );
    await client.query('COMMIT');
    res.status(201).json({ coins: updated[0].coins, benchSpeciesId: speciesId });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 連線本身可能已經斷了，rollback失敗就不用管 */ }
    console.error('pet buy-second error:', e.message);
    res.status(503).json({ error: 'db_error' });
  } finally {
    client.release();
  }
});

/* 切換寵物（2026-08-10新增）：把pets表跟pet_bench表的「每隻寵物專屬」欄位整組互換——切換之後
   目前顯示中的寵物永遠是pets這張表（跟原本一模一樣），其餘40多個既有寵物端點完全不用改一行，
   都繼續讀pets就對了。coins/裝飾/球數/Pocket TCG相關欄位留在pets上不參與互換，帳號共用不分寵物。
   備用中的那隻，飢餓值/好感度照樣隨真實時間流逝（沒有暫停邏輯），跟電子雞「疏於照顧會變差」
   的精神一致，切回去看到的是牠這段時間沒人理的真實結果。 */
app.post('/api/pet/switch', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: petRows } = await client.query(
      'SELECT species_id, happiness, hunger, last_fed_at, last_interaction_at FROM pets WHERE user_id = $1 FOR UPDATE', [req.user.id]
    );
    if (!petRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no_pet' }); }
    const { rows: benchRows } = await client.query(
      'SELECT species_id, happiness, hunger, last_fed_at, last_interaction_at FROM pet_bench WHERE user_id = $1 FOR UPDATE', [req.user.id]
    );
    if (!benchRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'no_bench_pet' }); }
    const active = petRows[0], bench = benchRows[0];
    await client.query(
      'UPDATE pets SET species_id = $1, happiness = $2, hunger = $3, last_fed_at = $4, last_interaction_at = $5 WHERE user_id = $6',
      [bench.species_id, bench.happiness, bench.hunger, bench.last_fed_at, bench.last_interaction_at, req.user.id]
    );
    await client.query(
      'UPDATE pet_bench SET species_id = $1, happiness = $2, hunger = $3, last_fed_at = $4, last_interaction_at = $5 WHERE user_id = $6',
      [active.species_id, active.happiness, active.hunger, active.last_fed_at, active.last_interaction_at, req.user.id]
    );
    await client.query('COMMIT');
    res.json({ speciesId: bench.species_id, happiness: bench.happiness, hunger: bench.hunger, benchSpeciesId: active.species_id });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 連線本身可能已經斷了，rollback失敗就不用管 */ }
    console.error('pet switch error:', e.message);
    res.status(503).json({ error: 'db_error' });
  } finally {
    client.release();
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

/* 鳥圖鑑——跟魚圖鑑（/api/pet/fish/dex）同一套邏輯，查pet_birds_discovered這張獨立的永久
   紀錄表，不是看目前pet_birds裡還擁不擁有。 */
app.get('/api/pet/bird/dex', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT bird_type FROM pet_birds_discovered WHERE user_id = $1', [req.user.id]);
    const discoveredSet = new Set(rows.map(r => r.bird_type));
    const dex = Object.entries(BIRD_TYPES)
      .map(([birdType, info]) => ({ birdType, ...info, discovered: discoveredSet.has(birdType) }));
    res.json({ dex });
  } catch (e) {
    console.error('pet bird dex error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pet/bird/display', requireAuth, async (req, res) => {
  const birdId = req.body?.birdId ?? null;
  try {
    if (birdId !== null) {
      const { rows } = await pool.query('SELECT 1 FROM pet_birds WHERE id = $1 AND user_id = $2', [birdId, req.user.id]);
      if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    }
    await pool.query('UPDATE pets SET display_bird_id = $1 WHERE user_id = $2', [birdId, req.user.id]);
    res.json({});
  } catch (e) {
    console.error('pet bird display error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

/* 鳥籠設定比照魚缸（2026-07-26應使用者要求）：賣鳥／標記最愛／一鍵賣重複，跟fish/sell、
   fish/favorite、fish/sell-duplicates逐一對照，只是資料表換成pet_birds+BIRD_TYPES。 */
app.post('/api/pet/bird/sell', requireAuth, async (req, res) => {
  const birdId = req.body?.birdId;
  try {
    const { rows } = await pool.query('SELECT bird_type, is_favorite FROM pet_birds WHERE id = $1 AND user_id = $2', [birdId, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    if (rows[0].is_favorite) return res.status(400).json({ error: 'is_favorite' });
    const price = BIRD_TYPES[rows[0].bird_type]?.sellPrice || 0;
    await pool.query('DELETE FROM pet_birds WHERE id = $1', [birdId]);
    const { rows: updated } = await pool.query(
      'UPDATE pets SET coins = coins + $1 WHERE user_id = $2 RETURNING coins', [price, req.user.id]
    );
    res.json({ coins: updated[0].coins, gained: price });
  } catch (e) {
    console.error('pet bird sell error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pet/bird/favorite', requireAuth, async (req, res) => {
  const birdId = req.body?.birdId;
  const favorite = !!req.body?.favorite;
  try {
    const { rows } = await pool.query(
      'UPDATE pet_birds SET is_favorite = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
      [favorite, birdId, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_owned' });
    res.json({ birdId, favorite });
  } catch (e) {
    console.error('pet bird favorite error:', e.message);
    res.status(503).json({ error: 'db_error' });
  }
});

app.post('/api/pet/bird/sell-duplicates', requireAuth, async (req, res) => {
  try {
    const { rows: deleted } = await pool.query(
      `WITH ranked AS (
         SELECT id, bird_type,
           ROW_NUMBER() OVER (PARTITION BY bird_type ORDER BY caught_at DESC) AS rn
         FROM pet_birds
         WHERE user_id = $1 AND is_favorite = FALSE
       )
       DELETE FROM pet_birds WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
       RETURNING id, bird_type`,
      [req.user.id]
    );
    const gained = deleted.reduce((sum, row) => sum + (BIRD_TYPES[row.bird_type]?.sellPrice || 0), 0);
    const { rows: updated } = await pool.query(
      'UPDATE pets SET coins = coins + $1 WHERE user_id = $2 RETURNING coins', [gained, req.user.id]
    );
    res.json({ coins: updated[0].coins, gained, soldIds: deleted.map(r => r.id), soldCount: deleted.length });
  } catch (e) {
    console.error('pet bird sell-duplicates error:', e.message);
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
      'SELECT item_id, pos_x, pos_y, scale FROM pet_decorations WHERE user_id = $1 AND pos_x IS NOT NULL', [targetId]
    );
    const decorations = decorRows.map(r => ({ itemId: r.item_id, x: r.pos_x, y: r.pos_y, scale: r.scale }));
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

// 2026-08-06新增：GM一鍵開通某個玩家帳戶的全部Pocket TCG卡牌（每張2張，跟牌組同名卡上限一致）。
// pocket_collection的user_id只FK到users，不需要那個玩家先選過起始寶可夢（不像開包/收藏頁那些
// 動到pets.coins的功能）。用GREATEST(count,2)而不是直接SET——玩家如果已經靠正常抽卡/合成
// 擁有比2還多張，不該被這個操作往下砍。
app.post('/api/admin/users/:id/pocket/grant-all', requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    for (const card of POCKET_CARDS) {
      await pool.query(
        `INSERT INTO pocket_collection (user_id, card_id, count) VALUES ($1, $2, 2)
         ON CONFLICT (user_id, card_id) DO UPDATE SET count = GREATEST(pocket_collection.count, 2)`,
        [id, card.id]
      );
    }
    res.json({ granted: POCKET_CARDS.length });
  } catch (e) {
    console.error('admin pocket grant-all error:', e.message);
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
    await pool.query('UPDATE users SET password_hash = $1, session_token = NULL WHERE id = $2', [await hashPassword(newPassword), id]);
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
  ws.pocketRoomCode = null;
  ws.pocketRole     = null;

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
    if (room) {
      if (ws.role === 'spectator') {
        room.spectators = (room.spectators || []).filter(s => s !== ws);
      } else {
        const op = ws.role === 'p1' ? 'p2' : 'p1';
        send(room[op], { type: 'opponent_disconnected' });
        room[ws.role] = null;
        // 2026-07-30 review發現的記憶體洩漏修正：原本寫成「未結束的對局才delete」，等於每一場
        // 正常打完(phase==='done')的對局永遠留在rooms這個Map裡，長期跑下去記憶體只會一直長。
        // 改成：未結束就照原本邏輯直接清掉；已結束的話，等雙方都斷線了才清掉（讓賽後畫面/觀戰者
        // 還能看一下結果，不會一結束就馬上被踢），不是「已結束的房間永遠留著」。
        if (room.phase !== 'done' || (!room.p1 && !room.p2)) rooms.delete(ws.roomCode);
      }
    }

    const pRoom = pocketRooms.get(ws.pocketRoomCode);
    if (pRoom && (ws.pocketRole === 'p1' || ws.pocketRole === 'p2')) {
      const op = ws.pocketRole === 'p1' ? 'p2' : 'p1';
      send(pRoom[op], { type: 'pocket_opponent_disconnected' });
      pRoom[ws.pocketRole] = null;
      if (pRoom.phase !== 'done' || (!pRoom.p1 && !pRoom.p2)) pocketRooms.delete(ws.pocketRoomCode);
    }
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

// 2026-08-14新增：從type==='attack'原本的內文抽出來的「真正執行這次攻擊交換」邏輯，
// 讓很長的attack handler讀起來更清楚。room/G/role/op跟原本inline時完全同名同義，
// 只是從閉包變成參數傳入。（原本這個抽出也是為了配合帕路奇亞「空間切割」的攻擊前反應式
// 選擇暫停機制，該機制已於同日改版拿掉——見battle-logic skill同日的後續修正說明——
// 但抽成獨立函式本身仍然合理，故保留。）
function resolveAttackExchangeSrv(room, G, role, op, attacker, defender, atk, atkCost, aBuff, dBuff, log) {
  const switchGuardMult = G[`${op}SwitchGuard`] ? 0.9 : 1;
  G[`${op}SwitchGuard`] = false; // consumed by this incoming attack
  // 格擋（原待機）：下一次受到的攻擊傷害×0.6，跟switchGuard同一套「不論有沒有真的扣血都消耗」寫法
  const standbyGuardMult = G[`${op}StandbyGuard`] ? 0.6 : 1;
  G[`${op}StandbyGuard`] = false; // consumed by this incoming attack
  G[`${role}Energy`] -= atkCost;
  if (atk.support) {
    executeSupportMoveSrv(attacker, defender, atk, role, op, G, log);
  } else {
    if (atk.bonusEnergy) G[`${role}BonusEnergyNextTurn`] = (G[`${role}BonusEnergyNextTurn`] || 0) + atk.bonusEnergy;
    doAttack(attacker, defender, atk, aBuff, dBuff, log, G, switchGuardMult, standbyGuardMult);
    // 2026-08-13重新設計：羅馬鬥技場/亡靈墓園/魔幻空間三張場地卡共用同一套「雙重攻擊」——
    // 對應屬性的招式額外發動第二次（傷害×0.4）。防禦方沒被第一下打倒的話這裡直接補打，
    // 讓後面既有的attackerDied/defenderDied判斷自然吃到兩下打完的最終狀態；如果第一下
    // 就把防禦方打倒了，改記錄在G[op+PendingColosseumHit]，等對方選完KO替補（ko_switch handler）
    // 才真正對新上場的寶可夢補打第二下，跟pokemon_battle.html的attackWithStadiumDouble同一套邏輯
    const atkTypeForDouble = aBuff.typeOverride || atk.type;
    // 連續攻擊／親子羈絆（multi-strike，2026-08-14新增）：不限場地、不限招式屬性，任何招式
    // 攻擊完後都會再以×0.2傷害追打一次，跟場地卡雙重攻擊共用同一套「KO補位後才打第二下」
    // 邏輯，只是倍率不同（0.2而非0.4），跟pokemon_battle.html的attackWithStadiumDouble同步
    const attackerAbilityForDouble = isAbilitySealedSrv(role, G) ? null : attacker.ability;
    const isMultiStrike = attackerAbilityForDouble?.id === 'multi-strike';
    // 太陽核心（solar-core，2026-08-15新增）：跟連續攻擊同一套「打完再補一下」邏輯，第二次傷害
    // 同樣×0.2，差別是第二下的招式屬性強制變成火屬性
    const isSolarCore = attackerAbilityForDouble?.id === 'solar-core';
    if ((STADIUM_DOUBLE_ATTACK[G.activeStadium?.id] === atkTypeForDouble || isMultiStrike || isSolarCore) && attacker.cur > 0) {
      const secondHitMult = (isMultiStrike || isSolarCore) ? 0.2 : 0.4;
      const secondAtk = isSolarCore ? { ...atk, _secondHitMult: secondHitMult, type: 'fire' } : { ...atk, _secondHitMult: secondHitMult }; // 見doAttack內_secondHitMult的說明，不能只砍atk.dmg
      if (defender.cur > 0) {
        doAttack(attacker, defender, secondAtk, aBuff, dBuff, log, G, 1, 1);
      } else {
        G[`${op}PendingColosseumHit`] = { attackerRole: role, atk: secondAtk };
      }
    }
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
  // Defender's own lingering poison/burn is checked here too (Pokémon Checkup timing checks
  // BOTH actives at every turn-end, not just role's) — 2026-08-07 fix. A no-op if the attack
  // itself already KO'd the defender (applyEndOfTurnStatusSrv returns immediately once
  // poke.cur <= 0), so this only matters when the defender survived the hit.
  if (defender.cur > 0) applyEndOfTurnStatusSrv(defender, log, G, op);

  // 治癒彩虹：這次交鋒真的把誰打到0血了，先讓牠原地復活一次，再判定是否真的算倒下
  tryHealingRainbowRevive(attacker, log);
  tryHealingRainbowRevive(defender, log);

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

    /* ── Pocket TCG lobby（獨立房間系統，見上面 pocketRooms 區塊） ── */
    if (type === 'pocket_create_room') {
      const code = genCode();
      const pRoom = { code, p1: ws, p2: null, phase: 'waiting', p1Deck: null, p2Deck: null, p1Ready: false, p2Ready: false, firstPlayer: null, p1UserId: ws.userId ?? null, p2UserId: null, p1Username: ws.username ?? null, p2Username: null };
      pocketRooms.set(code, pRoom);
      ws.pocketRoomCode = code; ws.pocketRole = 'p1';
      send(ws, { type: 'pocket_room_created', code, role: 'p1' });
      return;
    }

    if (type === 'pocket_join_room') {
      const code = (msg.code || '').toUpperCase().trim();
      const pRoom = pocketRooms.get(code);
      if (!pRoom) { send(ws, { type: 'error', message: '找不到房間，請確認代碼' }); return; }
      // 2026-08-05修正：房間滿了（p2已存在）原本會把第3個人悄悄接成'spectator'角色，但
      // Pocket從沒真的做過觀戰功能——pocketBroadcastState只送給p1/p2，client也完全沒有
      // 處理pocket_spectate_joined這個訊息的case，導致第3個人進來後畫面永遠卡在等待畫面、
      // 什麼都不會發生，也不會有任何錯誤提示。跟main PvP不同（那邊觀戰是真的做完的功能），
      // Pocket這段是半成品，直接讓「房間已滿」明確擋下比較符合使用者實際遇到的情境
      // （通常是誤用了已經有兩人在用的房號），不是刻意要拿掉一個已完成的功能。
      if (pRoom.p2) { send(ws, { type: 'error', message: '房間已滿（已有兩人在對戰），請確認房號或請對方開一個新房間' }); return; }
      pRoom.p2 = ws;
      ws.pocketRoomCode = code; ws.pocketRole = 'p2';
      pRoom.p2UserId = ws.userId ?? null;
      pRoom.p2Username = ws.username ?? null;
      pRoom.phase = 'deckselect';
      send(ws,        { type: 'pocket_joined', role: 'p2', opponentUsername: pRoom.p1Username });
      send(pRoom.p1,  { type: 'pocket_opponent_joined', username: pRoom.p2Username });
      return;
    }

    if (type === 'pocket_submit_deck') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom) { send(ws, { type: 'error', message: '房間已不存在，請重新建立房間' }); return; }
      const pRole = ws.pocketRole;
      if (pRole !== 'p1' && pRole !== 'p2') return;
      const err = validatePocketDeck(msg.deck);
      if (err) { send(ws, { type: 'error', message: err }); return; }
      // 已登入玩家額外驗證擁有量——訪客沒有DB收藏紀錄（client端本地隨機100張，server端
      // 完全不知道），跳過這層檢查，跟訪客一直以來「不做強制驗證，信任client」的既有慣例一致
      if (ws.userId && pool) {
        const ownErr = await pocketValidateOwnedDeck(ws.userId, msg.deck);
        if (ownErr) { send(ws, { type: 'error', message: ownErr }); return; }
      }
      // 玩家自選能量種類（見pocketValidateEnergyTypes）——驗證不過或沒傳就是null，
      // pocketFreshSide收到null會照舊退回自動偵測，不會整個提交失敗
      const energyTypes = pocketValidateEnergyTypes(msg.energyTypes);
      if (pRole === 'p1') { pRoom.p1Deck = msg.deck; pRoom.p1EnergyTypes = energyTypes; pRoom.p1Ready = true; }
      else                { pRoom.p2Deck = msg.deck; pRoom.p2EnergyTypes = energyTypes; pRoom.p2Ready = true; }
      send(pRoom[pRole === 'p1' ? 'p2' : 'p1'], { type: 'pocket_opponent_ready' });
      if (pRoom.p1Ready && pRoom.p2Ready) {
        pRoom.firstPlayer = Math.random() < 0.5 ? 'p1' : 'p2';
        pRoom.phase = 'playing';
        pRoom.G = buildPocketG(pRoom);
        send(pRoom.p1, { type: 'pocket_match_start', firstPlayer: pRoom.firstPlayer, p1Username: pRoom.p1Username, p2Username: pRoom.p2Username, ...pocketViewFor(pRoom.G, 'p1') });
        send(pRoom.p2, { type: 'pocket_match_start', firstPlayer: pRoom.firstPlayer, p1Username: pRoom.p1Username, p2Username: pRoom.p2Username, ...pocketViewFor(pRoom.G, 'p2') });
      }
      return;
    }

    /* ── Pocket TCG：開局選主戰/板凳 ── */
    if (type === 'pocket_setup_board') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'setup') return;
      const G = pRoom.G;
      const role = ws.pocketRole;
      const side = G[role];
      if (side.boardReady) return;
      const activeHandCard = side.hand.find(c => c.uid === msg.active);
      if (!activeHandCard || !pocketIsPlayableAsBasic(activeHandCard)) {
        send(ws, { type: 'error', message: '主戰寶可夢必須是基礎寶可夢' }); return;
      }
      const benchUids = Array.isArray(msg.bench) ? msg.bench.slice(0, 3) : [];
      const benchHandCards = benchUids.map(u => side.hand.find(c => c.uid === u)).filter(Boolean);
      if (benchHandCards.some(c => !pocketIsPlayableAsBasic(c))) {
        send(ws, { type: 'error', message: '板凳只能放基礎寶可夢' }); return;
      }
      const usedUids = new Set([activeHandCard.uid, ...benchHandCards.map(c => c.uid)]);
      side.hand = side.hand.filter(c => !usedUids.has(c.uid));
      // 2026-08-12修正：開局擺盤時G.turnNumber永遠是1（setup階段兩人都還沒真正輪到，turnNumber
      // 要等pocketStartNextTurn才會遞增），先前兩邊起始board都直接set boardTurn=G.turnNumber(1)。
      // 對先攻方這剛好等於他的第1回合turnNumber，「這回合剛上場不能用」的門檻正確擋住；但後攻方
      // 的第1回合turnNumber其實是2，1<2讓boardTurn門檻直接被繞過去——後攻方一開局就能對起始board
      // 上的寶可夢使用「上場滿1回合才能用」的特性/糖果跳階進化，變成先後攻規則不對稱（使用者
      // 回報「圓陸鯊在後手方第一回合不應該能發動特性」）。改成跟pocketIsFirstTurnFor同一套
      // 判斷式：起始boardTurn要設成「這個玩家自己第1回合」對應的turnNumber（先攻=1、後攻=2），
      // 不是不分先後攻都套用setup當下的G.turnNumber。這是通用修法，Rare Candy/一般進化等其餘
      // 所有boardTurn門檻檢查都會一併受益，不用逐一特判。
      const initialBoardTurn = role === pRoom.firstPlayer ? 1 : 2;
      const activeCard = pocketInstantiateBoardCard(activeHandCard, initialBoardTurn);
      side.active = activeCard;
      side.bench = benchHandCards.map(c => pocketInstantiateBoardCard(c, initialBoardTurn));
      side.boardReady = true;
      send(ws, { type: 'pocket_setup_wait' });
      if (G.p1.boardReady && G.p2.boardReady) {
        pocketStartFirstTurn(G);
        G.phase = G.phase === 'setup' ? 'active' : G.phase; // pocketStartFirstTurn可能因抽牌落敗而設成done
        pocketBroadcastState(pRoom);
      }
      return;
    }

    /* ── Pocket TCG：對戰中的操作 ── */
    if (type === 'pocket_attach_energy') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole; const op = role === 'p1' ? 'p2' : 'p1';
      if (G.turn !== role) return;
      const side = G[role]; const oppSide = G[op];
      if (!side.pendingEnergy || side.energyAttachedThisTurn) { send(ws, { type: 'error', message: '沒有可附加的能量' }); return; }
      const target = [side.active, ...side.bench].find(p => p && p.uid === msg.target);
      if (!target) return;
      // 2026-08-06新增：能量鎖定——只封鎖「附加到主戰位置」，卡片原文是"attach...to their Active
      // Pokémon"，板凳寶可夢不受影響，所以只在目標是主戰時才擋
      if (target.uid === side.active?.uid && side.energyLockedUntilTurn === G.turnNumber) {
        send(ws, { type: 'error', message: '能量鎖定中，這回合無法把能量附加到主戰寶可夢' }); return;
      }
      const attachedType = side.pendingEnergy;
      target.energy.push(attachedType);
      side.pendingEnergy = null;
      side.energyAttachedThisTurn = true;
      // Flower Shield/Soothing Wind：剛附加能量後，target可能剛好新符合「附有能量」的資格，
      // 立刻檢查要不要治癒既有的異常狀態（見pocketApplySoothingCure定義處的說明）
      pocketApplySoothingCure(side);
      // 附加能量觸發型特性（2026-08-07新增，跟按鈕觸發/進化觸發/上場觸發都不同的第五種類型）：
      // Lunar Plumage(治療自己20)/Nightmare Aura(打對方主戰20)只在附加的能量剛好符合屬性時
      // 才觸發；Comatose/Snoozing Habit是「只要在主戰位置附加任何能量就陷入睡眠」；
      // Electromagnetic Wall是「對手」的特性——輪到我方附加能量時要檢查oppSide.active
      const targetAbility = target.abilities?.[0]?.name;
      if (targetAbility === 'Lunar Plumage' && attachedType === 'Psychic') {
        target.curHp = Math.min(target.hp, target.curHp + 20);
        pocketEmitCardActivation(G, role, target, '特性觸發：Lunar Plumage');
      }
      if (targetAbility === 'Nightmare Aura' && attachedType === 'Darkness' && oppSide.active) {
        oppSide.active.curHp = Math.max(0, oppSide.active.curHp - 20);
        pocketEmitCardActivation(G, role, target, '特性觸發：Nightmare Aura');
        if (oppSide.active.curHp <= 0) {
          // 2026-08-16應使用者回報修正：附加能量不是攻擊，這裡擊倒對手不該連帶結束回合（跟
          // pocket_use_ability handler、pocketResolveAmbientKOs同一個道理），endsTurn=false
          pocketResolveActiveKO(G, op, true, false);
          if (G.phase === 'forced_switch' || G.phase === 'done') { pocketBroadcastState(pRoom); return; }
        }
      }
      if ((targetAbility === 'Comatose' || targetAbility === 'Snoozing Habit') && target.uid === side.active?.uid && target.status == null) {
        target.status = 'asleep';
        pocketEmitCardActivation(G, role, target, `特性觸發：${targetAbility}`);
      }
      // Gothitelle（2026-08-08新增）：招式效果種在對手主戰身上的「下回合附加能量到牠身上就
      // 睡著」陷阱——跟Comatose/Snoozing Habit（常駐特性、任何能量都觸發）方向類似，但這是
      // 招式種的限時debuff，且限定被種的那隻pokemon instance（不是「主戰位置」這個抽象概念）
      if (target.sleepTrapUntilTurn === G.turnNumber && target.status == null) {
        target.status = 'asleep';
        pocketEmitCardActivation(G, op, target, 'Gothitelle陷阱生效');
      }
      if (oppSide.active?.abilities?.[0]?.name === 'Electromagnetic Wall') {
        target.curHp = Math.max(0, target.curHp - 20);
        pocketEmitCardActivation(G, op, oppSide.active, '特性觸發：Electromagnetic Wall');
        if (target.curHp <= 0) {
          if (target.uid === side.active?.uid) {
            // 同上：附加能量不是攻擊，Electromagnetic Wall擊倒也不該結束回合
            pocketResolveActiveKO(G, role, true, false);
            if (G.phase === 'forced_switch' || G.phase === 'done') { pocketBroadcastState(pRoom); return; }
          } else {
            pocketResolveBenchKOs(G, side, op);
          }
        }
      }
      // Buggy Evolution（2026-08-08新增）：跟"Put a random card from your deck that evolves
      // from this Pokémon..."這個既有招式效果（3805行）同一套進化mutation邏輯，只是觸發時機
      // 換成「被附加能量的當下」、目標固定是target（不是ctx.attacker），沒有獨立抽成共用函式
      // （這個mutation只有這2處在用，抽函式的維護成本大於重複10行程式碼）
      if (targetAbility === 'Buggy Evolution') {
        const candidates = side.deck.map((c, i) => ({ c, i })).filter(({ c }) => c.category === 'Pokemon' && c.evolveFrom === target.name);
        if (candidates.length) {
          const pick = candidates[Math.floor(Math.random() * candidates.length)];
          side.deck.splice(pick.i, 1);
          const preservedDamage = (target.hp || 0) - (target.curHp ?? target.hp ?? 0);
          const preservedEnergy = target.energy;
          const preservedUid = target.uid;
                Object.assign(target, structuredClone(POCKET_CARDS_BY_ID[pick.c.id]));
          target.uid = preservedUid; target.energy = preservedEnergy;
          target.status = null; target.poisoned = false; target.burned = false; // 2026-08-16應使用者要求：進化時異常狀態要清掉
          target.hp += pocketToolHpBonusAmount(target); // Object.assign後hp已是純base值(不含Tool加成)，直接加回新加成即可，不能算delta
          target.curHp = Math.max(1, (target.hp || 0) - preservedDamage);
          target.boardTurn = G.turnNumber;
          target._realAbilities = undefined; // 2026-08-08修正：進化後身分變了，清掉舊快取讓特性正確重抓
          pocketApplyDoubleType(target);
          side.deck = pocketShuffle(side.deck);
          pocketEmitCardActivation(G, role, target, '特性觸發：Buggy Evolution');
        }
      }
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_bench_play') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole;
      if (G.turn !== role) return;
      const side = G[role];
      if (side.bench.length >= 3) { send(ws, { type: 'error', message: '板凳已滿' }); return; }
      const card = side.hand.find(c => c.uid === msg.handUid);
      if (!card || !pocketIsPlayableAsBasic(card)) { send(ws, { type: 'error', message: '只能上場基礎寶可夢' }); return; }
      const boardCard = pocketInstantiateBoardCard(card, G.turnNumber);
      side.bench.push(boardCard);
      side.hand = side.hand.filter(c => c.uid !== card.uid);
      // 2026-08-07新增：第三種特性觸發時機——「從手牌上場到板凳時」（跟按鈕觸發/進化觸發都不同），
      // 目前只有Infiltrating Inspection這一種，直接內嵌判定，沒必要為了1張卡另開一個像
      // EVOLVE_TRIGGER_ABILITIES那樣的table
      if (boardCard.abilities?.[0]?.name === 'Infiltrating Inspection') {
        const op = role === 'p1' ? 'p2' : 'p1';
        send(ws, { type: 'pocket_peek', title: '對手手牌', cards: G[op].hand });
        pocketEmitCardActivation(G, role, boardCard, '特性觸發：Infiltrating Inspection');
      }
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_discard_fossil') { // 化石卡「隨時可以從場上棄掉」
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole;
      if (G.turn !== role) return;
      const side = G[role];
      if (side.active?.uid === msg.target && side.active.isFossil) {
        side.discard.push(side.active); side.active = null;
        // 棄掉的是主戰，場上不能空著沒人——跟Parasol Lady/Professor Turo同一套強制換人流程
        pocketEnterForcedSwitch(G, role, 'noEndTurn');
      } else {
        const idx = side.bench.findIndex(p => p.uid === msg.target && p.isFossil);
        if (idx < 0) return;
        side.discard.push(side.bench[idx]); side.bench.splice(idx, 1);
      }
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_play_item' || type === 'pocket_play_supporter') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole; const op = role === 'p1' ? 'p2' : 'p1';
      if (G.turn !== role) return;
      const side = G[role]; const oppSide = G[op];
      const card = side.hand.find(c => c.uid === msg.handUid);
      if (!card || card.category !== 'Trainer') return;
      const isSupporter = card.trainerType === 'Supporter';
      if (type === 'pocket_play_item' && isSupporter) return;
      if (type === 'pocket_play_supporter' && !isSupporter) return;
      if (isSupporter) {
        if (side.supporterUsedThisTurn) { send(ws, { type: 'error', message: '這回合已經用過支援者卡了' }); return; }
        if (side.supporterLockedUntilTurn === G.turnNumber) { send(ws, { type: 'error', message: '這回合不能使用支援者卡' }); return; }
        if (oppSide.active?.abilities?.some(a => a.name === 'Shadowy Spellbind')) {
          send(ws, { type: 'error', message: '對方的耿鬼ex場上時無法使用支援者卡' }); return;
        }
      } else if (side.itemLockedUntilTurn === G.turnNumber) {
        send(ws, { type: 'error', message: '這回合不能使用道具卡' }); return;
      }
      // Massive Body（2026-08-08新增）：對方主戰持有時，我方不能打出場地卡——跟耿鬼ex擋支援者卡
      // 是同一種「持有者在對方主戰位置時封鎖某類訓練師卡」的機制，只是這次擋的是Stadium
      if (card.trainerType === 'Stadium' && oppSide.active?.abilities?.[0]?.name === 'Massive Body') {
        send(ws, { type: 'error', message: '對方場上有Massive Body持有者在主戰位置，無法使用場地卡' }); return;
      }
      const handler = TRAINER_EFFECTS[card.effectId || card.id]; // 高星版角色支援者卡查回base id的效果
      if (!handler) { send(ws, { type: 'error', message: '這張卡的效果尚未實作' }); return; }
      const ctx = { G, role, op, side, oppSide, pRoom };
      const statusSnapA = pocketSnapshotStatus(side), statusSnapB = pocketSnapshotStatus(oppSide);
      const benchSnap = pocketSnapshotBenchHp(oppSide);
      const healSnap = pocketSnapshotAllHp(G);
      const err = handler(ctx, msg);
      if (err) { send(ws, { type: 'error', message: err }); return; }
      // 2026-08-12修正：場地卡的主動觸發效果(pocket_use_stadium，Mesagoza等5張)用stadiumUsedThisTurn
      // 卡「每回合1次」，這個旗標原本只在回合開始重置（見pocketAdvanceTurn），沒有隨「換上一張不同
      // 的新場地卡」重置——導致這回合已經觸發過舊場地效果後，換上完全不同的新場地卡，新場地卡的
      // 觸發按鈕仍然被視為「已用過」而擋住，明明是全新的一張卡（使用者回報「放上新場地應該要能發
      // 效果」）。場地卡是雙方共用的單一實體，這裡直接重置雙方旗標，不分是誰打出這張新場地卡。
      if (card.trainerType === 'Stadium') { G.p1.stadiumUsedThisTurn = false; G.p2.stadiumUsedThisTurn = false; }
      pocketEnforceStatusImmunity(side, statusSnapA); pocketEnforceStatusImmunity(oppSide, statusSnapB);
      pocketEnforceBenchImmunity(oppSide, benchSnap);
      pocketEnforceHealBlock(G, healSnap);
      side.hand = side.hand.filter(c => c.uid !== card.uid);
      // Lucky Ice Pop（2026-08-07新增）：真的有回到血且硬幣正面時，這張卡直接回手牌而不進棄牌堆
      if (ctx.keepInHand) side.hand.push(card); else side.discard.push(card);
      if (isSupporter) side.supporterUsedThisTurn = true;
      pocketEmitCardActivation(G, role, card, isSupporter ? '使用支援者卡' : '使用道具卡');
      // 2026-08-05修正：訓練師卡效果裡的擲硬幣（例如小霞連續丟到反面為止）原本完全沒有組
      // lastEvent，client端的擲硬幣動畫只有pocket_attack這條路徑會播放——結果是效果其實正確
      // 執行了（能量真的有附加），但畫面上完全看不到任何硬幣翻轉，玩家會誤以為卡片沒作用。
      // client的handlePocketEvent本來就是看lastEvent.coinFlips就播動畫，不看kind，這裡補上
      // 就好，不用動到client。同一批順便補上補血飄字（Potion/Erika）。
      if (ctx.coinFlips?.length || ctx.healUid) {
        G.lastEvent = { seq: ++G.eventSeq, kind: 'trainer', coinFlips: ctx.coinFlips || null, healUid: ctx.healUid || null, healAmount: ctx.healAmount || 0 };
      }
      // 2026-08-08修正：跟pocket_attack的peekOpponentHand同一個bug，interactive旗標讓client
      // 端在後面接著needsChoice互動選擇時跳過唯讀showPeek彈窗（例如Silver：揭露對手手牌+選1張
      // 支援者洗回牌庫），不然唯讀彈窗的z-index比互動選擇框高，會直接蓋住真正要點的畫面
      if (ctx.peekHand) send(ws, { type: 'pocket_peek', title: '對手手牌', cards: ctx.peekHand, interactive: !!ctx.needsChoice });
      if (ctx.peekDeck) send(ws, { type: 'pocket_peek', title: '牌庫頂3張', cards: ctx.peekDeck });
      // May（2026-08-08新增）：跟pocket_evolve的ctx.needsChoice同一套convention，第一次用在
      // 訓練師卡流程——卡片本身已經在上面移出手牌進棄牌堆，這裡只是暫停等玩家選子效果的目標
      if (ctx.needsChoice) {
        G.phase = 'attack_choice';
        G.pendingChoice = { role, ...ctx.needsChoice };
        pocketBroadcastState(pRoom);
        return;
      }
      // Kiawe（2026-08-08新增）：卡面文字明講「Your turn ends」，跟pocket_use_ability的
      // endTurnAfter是同一個convention，這裡是第一次在訓練師卡流程用到
      if (ctx.endTurnAfter) { pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return; }
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_use_ability') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole; const op = role === 'p1' ? 'p2' : 'p1';
      if (G.turn !== role) return;
      const side = G[role]; const oppSide = G[op];
      const poke = pocketFindOwn(side, msg.pokemonUid);
      const ability = poke?.abilities?.[0];
      if (!poke || !ability || !ABILITY_EFFECTS[ability.name]) return;
      // Shadow Void（2026-08-08新增）：卡面是「as often as you like」，跟其他「每回合限用1次」
      // 的特性方向相反，用名字白名單跳過once-per-turn gate（只有這一個特性需要，不值得為此
      // 改整個ABILITY_EFFECTS的資料結構加欄位）。渦輪電壓/渦輪火焰（2026-08-10新增，Fan Made
      // 系列）同一種情況——卡面沒有「Once during your turn」限定語，判定成同樣不限次數。
      // 覺醒（圓陸鯊FM-004，2026-08-12新增）：不是真的不限次數（進化完就不再是圓陸鯊，這個
      // 特性物理上不可能再觸發第二次）——放進這份白名單純粹是為了不要讓下面的
      // abilitiesUsedThisTurn.push(poke.uid)執行，否則poke.uid在進化前後是同一個（preservedUid），
      // 會害剛進化出來的烈咬陸鯊被誤判成「這回合已經用過特性」，導致牠自己的魯莽剪除同一回合
      // 完全按不了（使用者回報「透過圓陸鯊特性進化出來的烈咬陸鯊無法使用特性」）。
      const unlimitedUse = ability.name === 'Shadow Void' || ability.name === '渦輪電壓' || ability.name === '渦輪火焰' || ability.name === '覺醒';
      if (!unlimitedUse && side.abilitiesUsedThisTurn.includes(poke.uid)) { send(ws, { type: 'error', message: '這隻寶可夢這回合已經用過特性了' }); return; }
      const abilityCtx = { G, role, op, side, oppSide };
      const statusSnapA = pocketSnapshotStatus(side), statusSnapB = pocketSnapshotStatus(oppSide);
      const benchSnap = pocketSnapshotBenchHp(oppSide);
      const healSnap = pocketSnapshotAllHp(G);
      const err = ABILITY_EFFECTS[ability.name](abilityCtx, poke, msg);
      if (err) { send(ws, { type: 'error', message: err }); return; }
      pocketEnforceStatusImmunity(side, statusSnapA); pocketEnforceStatusImmunity(oppSide, statusSnapB);
      pocketEnforceBenchImmunity(oppSide, benchSnap);
      pocketEnforceHealBlock(G, healSnap);
      // 特性直接打死板凳/主戰（Roar in Unison自傷、Water Shuriken打對手、Combust自傷等）原本完全
      // 沒有KO判定——主戰打到0血會卡成殭屍卡，一直到下次攻擊/中毒checkup才會被別的地方順便處理掉。
      // 這裡補上跟pocket_attack_choice那幾個「延遲生效，自己重跑KO判定」分支同一套邏輯，但
      // endsTurn=false——用特性擊倒對手，卡面沒說「回合會結束」，只是需要選補位，選完應該還是
      // 原本這個人的回合，能接著攻擊或按結束回合鈕（使用者回報「特性擊倒不算回合結束」）。
      pocketResolveBenchKOs(G, side, op);
      pocketResolveBenchKOs(G, oppSide, role);
      if (G.phase === 'active' && side.active && side.active.curHp <= 0) pocketResolveActiveKO(G, role, true, false);
      if (G.phase === 'active' && oppSide.active && oppSide.active.curHp <= 0) pocketResolveActiveKO(G, op, true, false);
      if (pocketCheckWin(G)) { pocketBroadcastState(pRoom); return; }
      if (!unlimitedUse) side.abilitiesUsedThisTurn.push(poke.uid);
      pocketEmitCardActivation(G, role, poke, `使用特性：${ability.name}`);
      if (abilityCtx.coinFlips?.length || abilityCtx.healUid) {
        G.lastEvent = { seq: ++G.eventSeq, kind: 'ability', coinFlips: abilityCtx.coinFlips || null, healUid: abilityCtx.healUid || null, healAmount: abilityCtx.healAmount || 0 };
      }
      if (abilityCtx.peekDeck) send(ws, { type: 'pocket_peek', title: '牌庫頂1張', cards: abilityCtx.peekDeck });
      // Broken-Space Bellow文字寫明「用了這個特性，你的回合結束」——跟一般特性用完還能繼續行動不同
      if (abilityCtx.endTurnAfter) { pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return; }
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_evolve') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole;
      if (G.turn !== role) return;
      const side = G[role];
      const handCard = side.hand.find(c => c.uid === msg.handUid);
      const target = [side.active, ...side.bench].find(p => p && p.uid === msg.target);
      if (!handCard || !target) return;
      // Evolution Jammer（2026-08-08新增）：對手上回合種下的「這回合不能進化」封鎖
      if (side.evolveLockedUntilTurn === G.turnNumber) { send(ws, { type: 'error', message: '這回合不能讓寶可夢進化' }); return; }
      // Veevee 'volve：Eevee ex身上帶這個特性時，evolveFrom的比對對象從「Eevee ex」改成
      // 「Eevee」——原文"can evolve into any Pokémon that evolves from Eevee"，跟一般進化
      // 「手牌卡evolveFrom要精準等於場上這隻的名字」的規則不同，是這張卡專屬的例外
      const veeveeVolve = target.name === 'Eevee ex' && target.abilities?.[0]?.name === "Veevee 'volve";
      // 覺醒（FM-004圓陸鯊，2026-08-12新增）：卡面文字「可以從牌組將一張『烈咬陸鯊』直接疊在這張
      // 卡上進化」——跳過中間的尖牙陸鯊階，直接讓Basic疊Stage2，不是「evolveFrom要精準等於
      // 這隻的名字」的一般規則。只認非ex版本的烈咬陸鯊（name==='Garchomp'，跟'Garchomp ex'不同字串，
      // 卡面沒寫ex就不該含括）。一般的「這回合不能進化」boardTurn門檻不受影響，仍然照常檢查。
      const gibleAwaken = target.abilities?.[0]?.name === '覺醒';
      const evolveOk = gibleAwaken ? handCard.name === 'Garchomp' : handCard.evolveFrom === (veeveeVolve ? 'Eevee' : target.name);
      if (!evolveOk) { send(ws, { type: 'error', message: '進化對象不符' }); return; }
      // Boosted Evolution：卡面限定「in the Active Spot」，持有者在主戰位置時可以在自己第一
      // 回合/剛上場那回合就進化——跳過一般的「這回合不能進化」門檻，板凳上的不生效
      const boostedEvolution = target === side.active && target.abilities?.[0]?.name === 'Boosted Evolution';
      if (!boostedEvolution && target.boardTurn >= G.turnNumber) { send(ws, { type: 'error', message: '這隻寶可夢這回合不能進化' }); return; }
      // Primeval Law：卡面「Your opponent can't play any Pokémon from their hand to evolve
      // their Active Pokémon」——只擋「對手」進化「主戰位置」，board上只要有Aerodactyl ex在
      // （不限主戰/板凳）就生效，跟其他板凳進化不衝突
      const oppSideForEvolve = G[role === 'p1' ? 'p2' : 'p1'];
      if (target === side.active && [oppSideForEvolve.active, ...oppSideForEvolve.bench].some(p => p?.abilities?.[0]?.name === 'Primeval Law')) {
        send(ws, { type: 'error', message: '對方場上的Primeval Law讓你的主戰無法進化' }); return;
      }
      const preservedDamage = (target.hp || 0) - (target.curHp ?? target.hp ?? 0);
      const preservedEnergy = target.energy;
      const preservedUid = target.uid;
      // 2026-08-13修正：裝備Leaf Cape的Combee進化成Vespiquen後+30HP消失——Object.assign會把
      // target.hp整個換成新物種的印刷HP，蓋掉Tool卡先前套用的一次性加成，卻沒有依進化後的新
      // 條件（屬性/階段）重新判斷要不要補回來。見TOOL_HP_BONUS定義處的完整說明。
      Object.assign(target, structuredClone(POCKET_CARDS_BY_ID[handCard.id]));
      target.uid = preservedUid;
      target.energy = preservedEnergy;
      target.status = null; target.poisoned = false; target.burned = false; // 2026-08-16應使用者要求：進化時異常狀態要清掉
      target.hp += pocketToolHpBonusAmount(target); // Object.assign後hp已是純base值(不含Tool加成)，直接加回新加成即可，不能算delta
      target.curHp = Math.max(1, (target.hp || 0) - preservedDamage);
      target.boardTurn = G.turnNumber;
      // 2026-08-08修正：進化後身分變了（例如忍蛙/三首惡龍這類「前一階沒有特性，進化後才有」的
      // 寶可夢），pocketSyncAbilitySuppression快取的_realAbilities還是進化「前」那個物種的
      // 特性資料（很可能是null/沒有特性），下次broadcast時sync函式會用這份舊快取覆蓋掉剛
      // Object.assign上去的正確特性——清成undefined讓sync函式下次判斷「第一次見到」重新抓取，
      // 這是使用者回報「忍蛙/三首惡龍明明有特性卻沒得按」的根因，不是按鈕清單漏寫
      target._realAbilities = undefined;
      // 2026-08-13修正：化石寶可夢(name例如「舊珀」)可以走一般進化正常升成對應物種（例如化石
      // 翼龍evolveFrom==='Old Amber'），同一個isFossil殘留問題——見同一批A3-144糖果的說明
      target.isFossil = false;
      pocketApplyDoubleType(target);
      side.hand = side.hand.filter(c => c.uid !== handCard.uid);
      // 進化觸發型特性：進化「成」的這張新卡（target已經是進化後的資料）如果帶著這種特性，
      // 進化完成當下自動判定——跟按鈕觸發型特性是分開的兩套機制，見EVOLVE_TRIGGER_ABILITIES註解
      const evolveAbility = target.abilities?.[0]?.name;
      if (evolveAbility && EVOLVE_TRIGGER_ABILITIES[evolveAbility]) {
        const evolveCtx = { G, role, op: role === 'p1' ? 'p2' : 'p1', side, oppSide: G[role === 'p1' ? 'p2' : 'p1'] };
        EVOLVE_TRIGGER_ABILITIES[evolveAbility](evolveCtx, target);
        pocketEmitCardActivation(G, role, target, `特性觸發：${evolveAbility}`);
        // Healing Ripples/Search for Friends這類需要玩家自選目標的——跟pocket_attack的
        // ctx.needsChoice同一套convention，暫停等pocket_attack_choice收到選擇（noEndTurn:true
        // 讓解析完不會誤觸發pocketAdvanceTurn，因為進化本身不結束回合）
        if (evolveCtx.needsChoice) {
          G.phase = 'attack_choice';
          G.pendingChoice = { role, ...evolveCtx.needsChoice };
          pocketBroadcastState(pRoom);
          return;
        }
      }
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_retreat') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole;
      if (G.turn !== role) return;
      const side = G[role];
      if (side.retreatedThisTurn) { send(ws, { type: 'error', message: '這回合已經撤退過了' }); return; }
      const active = side.active;
      if (!active) return;
      if (active.status === 'asleep') { send(ws, { type: 'error', message: '睡眠中無法撤退' }); return; }
      if (active.status === 'paralyzed') { send(ws, { type: 'error', message: '麻痺中無法撤退' }); return; }
      if (active.isFossil || active.retreat == null) { send(ws, { type: 'error', message: '這隻沒有撤退成本可以撤退（化石卡不能撤退）' }); return; }
      const idx = side.bench.findIndex(p => p.uid === msg.target);
      if (idx < 0) return;
      // 奇異廣場（Peculiar Plaza）：雙方超能力寶可夢撤退成本-2，跟retreatDiscountThisTurn(X Speed)
      // 是同一個「扣減」概念但來源不同（場地常駐 vs 單次道具buff），兩者疊加直接一起扣
      const plazaDiscount = (G.activeStadium?.id === 'B2-155' && (active.types || []).includes('Psychic')) ? 2 : 0;
      // 被動特性：Levitate/Speed Link/Retreat Directive這類「撤退免費」，Sky Support是「板凳上
      // 的隊友讓主戰撤退-1」——都是2026-08-07新增的被動特性機制的一部分
      // Tool：Big Air Balloon(Stage2免費撤退)、Inflatable Boat(水屬性-1)，同一批新增
      const toolRetreat = pocketToolRetreatDiscount(active);
      const oppSide = G[role === 'p1' ? 'p2' : 'p1'];
      // Oranguru（2026-08-08新增）：招式效果種在對手身上的「下回合撤退多付1」時限debuff，
      // 跟pocketPassiveRetreatIncrease（Trap Territory，常駐特性）是不同來源，直接加總
      const retreatTrapIncrease = active.retreatIncreaseUntilTurn === G.turnNumber ? (active.retreatIncreaseAmount || 0) : 0;
      const cost = (pocketPassiveFreeRetreat(active, side, G, pocketIsFirstTurnFor(pRoom, G, role)) || toolRetreat.free) ? 0 : Math.max(0,
        (active.retreat || 0) - (side.retreatDiscountThisTurn || 0) - plazaDiscount - pocketPassiveBenchRetreatDiscount(active, side) - pocketPassiveSelfRetreatDiscount(active, side) - toolRetreat.discount + pocketPassiveRetreatIncrease(oppSide) + retreatTrapIncrease);
      if (active.energy.length < cost) { send(ws, { type: 'error', message: '能量不足，無法撤退' }); return; }
      if (cost > 0) {
        // 2026-08-12新增：主戰身上能量種類不只1種、且付完還會剩下能量時，讓玩家自選要棄哪些——
        // 原本永遠splice(0,cost)棄陣列最前面的，玩家完全沒得選要留哪種能量（使用者回報這個問題）。
        // 只有「真的有選擇空間」時才暫停（種類>1且不是要全部棄光），全同色或全部棄光都不用問，
        // 直接沿用原本的splice寫法。
        const distinctTypes = new Set(active.energy).size;
        if (distinctTypes > 1 && active.energy.length > cost) {
          G.phase = 'attack_choice';
          G.pendingChoice = { role, kind: 'retreat_discard', benchUid: msg.target, remaining: cost };
          pocketBroadcastState(pRoom);
          return;
        }
        // 2026-08-11修正：撤退成本付出的能量原本直接splice消失，沒有進discardEnergy——真實規則
        // 撤退付出的能量要進棄牌堆，跟Rainbow Cave/招式效果棄能量那批（19處call site）是同一個
        // 架構缺口，只是這處撤退成本付款當時漏掉沒一起修（使用者回報：特性拿到的能量，撤退付掉
        // 之後沒有出現在棄牌堆）
        side.discardEnergy.push(...active.energy.splice(0, cost));
      }
      pocketFinalizeRetreat(G, role, msg.target);
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_attack') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole; const op = role === 'p1' ? 'p2' : 'p1';
      if (G.turn !== role) return;
      const side = G[role]; const oppSide = G[op];
      const attacker = side.active;
      const atk = attacker && pocketEffectiveMoves(attacker, side)[msg.attackIndex];
      if (!atk) return;
      let wakeCoinFlip = null;
      if (attacker.status === 'paralyzed') {
        send(ws, { type: 'error', message: '麻痺中無法攻擊' }); attacker.status = null;
        G.lastEvent = { seq: ++G.eventSeq, kind: 'attackFailed', reason: 'paralyzed', attackerRole: role, attackerUid: attacker.uid };
        pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return;
      }
      if (attacker.status === 'asleep') {
        const woke = pocketFlipCoin({ G, role });
        wakeCoinFlip = woke;
        if (!woke) {
          send(ws, { type: 'error', message: '睡眠中，攻擊失敗' });
          G.lastEvent = { seq: ++G.eventSeq, kind: 'attackFailed', reason: 'asleep', attackerRole: role, attackerUid: attacker.uid, coinFlips: [false] };
          pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return;
        }
        attacker.status = null;
      }
      // 2026-08-06新增：混亂（Confused）——攻擊前擲硬幣，反面攻擊失敗且自己受到30傷害，
      // 正面攻擊照常進行、混亂繼續留著（不像睡眠醒來就解除，混亂要撤退才會清除，見既有
      // 撤退時清status的邏輯）。
      let confusionCoinFlip = null;
      if (attacker.status === 'confused') {
        const ok = pocketFlipCoin({ G, role });
        confusionCoinFlip = ok;
        if (!ok) {
          attacker.curHp = Math.max(0, attacker.curHp - 30);
          send(ws, { type: 'error', message: '混亂中，攻擊失敗，自己受到30傷害' });
          G.lastEvent = { seq: ++G.eventSeq, kind: 'attackFailed', reason: 'confused', attackerRole: role, attackerUid: attacker.uid, coinFlips: [false] };
          if (attacker.curHp <= 0) { pocketResolveActiveKO(G, role); pocketBroadcastState(pRoom); return; }
          pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return;
        }
      }
      if (attacker.cantAttackUntilTurn === G.turnNumber) { send(ws, { type: 'error', message: '這回合這隻寶可夢不能攻擊' }); pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return; }
      // Seal of Antiquity（2026-08-08新增）：跟cantAttackUntilTurn不同，這不是限時debuff，
      // 是持續性條件（板凳必須同時有雷吉洛克/雷吉艾斯/雷吉斯奇魯），不符合就單純擋下不結束回合
      if (attacker.abilities?.[0]?.name === 'Seal of Antiquity') {
        const benchNames = new Set(side.bench.map(p => p.name));
        if (!(benchNames.has('Regirock') && benchNames.has('Regice') && benchNames.has('Registeel'))) {
          send(ws, { type: 'error', message: '板凳必須同時有雷吉洛克、雷吉艾斯、雷吉斯奇魯，這隻才能攻擊' }); return;
        }
      }
      // 2026-08-06新增：指名招式封鎖（例如Torterra用完「巨型植物」後下回合不能再用同一招）——
      // 只擋住那一個招式，玩家還是可以選別的招式，所以跟能量不足一樣單純return，不結束回合。
      if (attacker.moveLockUntilTurn === G.turnNumber && attacker.moveLockName === atk.name) {
        send(ws, { type: 'error', message: `這回合不能使用【${atk.name}】` }); return;
      }
      // 被動特性：Sticky Membrane/Guard Dog Visage——持有者在對方主戰位置時，我方攻擊多付1個
      // 無色能量（不影響實際能量數量，Pocket TCG攻擊本來就不消耗能量，這只影響「付不付得起」的判定）
      const oppActiveCostAbility = oppSide.active?.abilities?.[0]?.name;
      const extraCost = (oppActiveCostAbility === 'Sticky Membrane' || oppActiveCostAbility === 'Guard Dog Visage') ? ['Colorless'] : [];
      let effectiveCost = [...(atk.cost || []), ...extraCost];
      // Future System（2026-08-08新增，之前因為找不到「哪些算Future Pokémon」的資料一度skip，
      // 後來確認這是SV系列固定的準古神獸清單才補上）：持有者在場（不限主戰/板凳），己方
      // Future Pokémon攻擊消耗-1無色能量，跟Vigor Link同一種「移除1個Colorless」寫法
      if (FUTURE_POKEMON_NAMES.has(attacker.name) && [side.active, ...side.bench].some(p => p?.abilities?.[0]?.name === 'Future System')) {
        let removed = false;
        effectiveCost = effectiveCost.filter(c => { if (!removed && c === 'Colorless') { removed = true; return false; } return true; });
      }
      // Barry（2026-08-07新增）：本回合指名寶可夢的攻擊消耗無色能量-2，只扣Colorless、不影響
      // 其他屬性能量需求——跟extraCost方向相反，同一個陣列上先加後扣
      if (side.namedCostDiscountThisTurn?.names.includes(attacker.name)) {
        let toRemove = side.namedCostDiscountThisTurn.amount;
        effectiveCost = effectiveCost.filter(c => { if (c === 'Colorless' && toRemove > 0) { toRemove--; return false; } return true; });
      }
      // Vigor Link：限定持有者自己攻擊時、我方場上有Arceus/Arceus ex，無色能量-1
      if (attacker.abilities?.[0]?.name === 'Vigor Link' && pocketHasArceus(side)) {
        let removed = false;
        effectiveCost = effectiveCost.filter(c => { if (!removed && c === 'Colorless') { removed = true; return false; } return true; });
      }
      // En-fruits-iastic：限定持有者自己攻擊時、身上有裝備Tool，草屬性能量-1
      if (attacker.abilities?.[0]?.name === "En-fruits-iastic" && attacker.tool) {
        let removed = false;
        effectiveCost = effectiveCost.filter(c => { if (!removed && c === 'Grass') { removed = true; return false; } return true; });
      }
      // Oranguru/Porygon-Z/Wo-Chien（2026-08-08新增）：招式效果種在defender(=attacker這裡)
      // 身上的「下回合攻擊多付N無色能量」時限debuff，跟extraCost（特性常駐）同一個陣列疊加方向
      if (attacker.costIncreaseUntilTurn === G.turnNumber) {
        effectiveCost = [...effectiveCost, ...Array(attacker.costIncreaseAmount || 0).fill('Colorless')];
      }
      // Boltund/Veluza（2026-08-08新增）：條件成立時完全取代成固定的替代花費，不是疊加/扣減
      if (atk.name === 'Defiant Spark' && attacker.curHp < attacker.hp) effectiveCost = ['Lightning'];
      if (atk.name === 'Shedding Spiral' && side.deck.length === 0) effectiveCost = ['Water'];
      if (!pocketCanPayCost(attacker, effectiveCost, side)) { send(ws, { type: 'error', message: '能量不足，無法使用這個招式' }); return; }
      const defender = oppSide.active;
      if (!defender) return;
      // 2026-08-06新增：「攻擊前擲硬幣，反面攻擊失敗」的封印效果（跟混亂不同，這個是對手招式
      // 施加在自己身上的debuff，不是自身異常狀態）——命中一次就清掉旗標，不會連續卡好幾回合。
      let flipLockCoinFlip = null;
      if (attacker.attackFlipLockUntilTurn === G.turnNumber) {
        attacker.attackFlipLockUntilTurn = 0;
        const ok = pocketFlipCoin({ G, role });
        flipLockCoinFlip = ok;
        if (!ok) {
          send(ws, { type: 'error', message: '對方的封印效果生效，這次攻擊被擋下' });
          G.lastEvent = { seq: ++G.eventSeq, kind: 'attackFailed', reason: 'flipLock', attackerRole: role, attackerUid: attacker.uid, coinFlips: [false] };
          pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return;
        }
      }

      const ctx = { G, role, op, side, oppSide, attacker, defender, atk, rawDamage: parseInt(String(atk.damage || '0').replace(/\D+/g, ''), 10) || 0, selfDamage: 0 };
      // Sweets Relay系（2026-08-08新增，Appletun/Vanillite/Slurpuff等共用同一個招式名字）：
      // usedSweetsRelayThisTurn在自己下次回合開始時(pocketStartNextTurn)會被promote成
      // usedSweetsRelayLastTurn；sweetsRelayUseCount是終生累計不重置（Alcremie用）
      if (atk.name === 'Sweets Relay') {
        side.usedSweetsRelayThisTurn = true;
        side.sweetsRelayUseCount = (side.sweetsRelayUseCount || 0) + 1;
      }
      // Cyclizar（2026-08-08新增）：「if you played a Supporter card from your hand during
      // this turn」——直接重用既有的supporterUsedThisTurn旗標，語意完全相同不用另開欄位
      if (atk.name === 'Driving Buddy' && side.supporterUsedThisTurn) ctx.rawDamage += 60;
      // 2026-08-06新增「無敵/免疫」機制：某些招式效果會讓自己下回合完全免疫傷害跟附加效果
      // （防禦方的invulnerableUntilTurn），命中就直接把這次攻擊的傷害跟效果都短路掉，
      // 用掉了要清掉旗標避免殘留到下下回合繼續檔。
      if (defender.invulnerableUntilTurn === G.turnNumber) {
        defender.invulnerableUntilTurn = 0;
        ctx.rawDamage = 0;
        ctx.skipMainDamage = true;
        ctx.invulnerableBlocked = true;
      } else {
        // Clear Veil（2026-08-08新增）：跟invulnerableUntilTurn不同，這是「常駐、只擋效果、
        // 不擋傷害」的道具——傷害照常往下走（mainDamage計算不受影響），只是效果函式整個不執行
        const effectFn = defender.tool?.id !== 'B4-149' && atk.effect && ATTACK_EFFECTS[atk.effect];
        if (effectFn) {
          const statusSnapA = pocketSnapshotStatus(side), statusSnapB = pocketSnapshotStatus(oppSide);
          const benchSnap = pocketSnapshotBenchHp(oppSide);
          const defenderEffectSnap = pocketSnapshotDefenderEffect(defender);
          const healSnap = pocketSnapshotAllHp(G);
          effectFn(ctx);
          pocketEnforceStatusImmunity(side, statusSnapA); pocketEnforceStatusImmunity(oppSide, statusSnapB);
          pocketEnforceBenchImmunity(oppSide, benchSnap);
          pocketEnforceDefenderEffectImmunity(defender, defenderEffectSnap);
          pocketEnforceHealBlock(G, healSnap);
        }
      }

      let mainDamage = 0;
      if (!ctx.skipMainDamage && ctx.rawDamage > 0) {
        mainDamage = ctx.rawDamage;
        if (side.giovanniBoostThisTurn) mainDamage += 10;
        if (side.blaineBoostNamesThisTurn?.includes(attacker.name)) mainDamage += 30;
        if (side.namedBoostThisTurn?.names.includes(attacker.name) && (!side.namedBoostThisTurn.exOnly || defender.ex)) mainDamage += side.namedBoostThisTurn.amount;
        if (side.typeBoostThisTurn && (attacker.types || []).includes(side.typeBoostThisTurn.type)) mainDamage += side.typeBoostThisTurn.amount;
        if (side.exOnlyBoostThisTurn && defender.ex) mainDamage += side.exOnlyBoostThisTurn;
        // Eevee Bag（2026-08-08新增）：跟typeBoostThisTurn同一種「這回合限定加傷」的flag，
        // 判斷條件是evolveFrom==='Eevee'而不是屬性，所以獨立開一個欄位不共用typeBoostThisTurn
        if (side.eeveeBoostThisTurn && attacker.evolveFrom === 'Eevee') mainDamage += 10;
        // 訓練場（Training Area）：雙方Stage1寶可夢的攻擊都+10——場地卡沒有「自己/對方」之分，
        // 不管是哪一方打出這張場地卡，雙方符合條件的攻擊都吃得到加成
        if (G.activeStadium?.id === 'B2-153' && attacker.stage === 'Stage1') mainDamage += 10;
        // 2026-08-06新增：指名招式下回合加成（例如Crabominable ex用完「大快朵頤」後預告下回合的
        // 「貪食連擊」+40）——跟moveLock是同一組欄位設計理念，只是這邊是加傷而不是封鎖
        if (attacker.moveBuffUntilTurn === G.turnNumber && attacker.moveBuffName === atk.name) mainDamage += attacker.moveBuffAmount;
        // Oricorio（2026-08-08新增）：跟moveBuffUntilTurn不同，這是「side全隊」下回合加傷（不限
        // 哪一隻攻擊，也不限招式名字），欄位掛在side不是攻擊者身上
        if (side.teamMoveBuffUntilTurn === G.turnNumber) mainDamage += side.teamMoveBuffAmount;
        // Miltank/Mega Mawile ex（2026-08-08新增）：「直到離開主戰位置」的可疊加加傷，限定同一招式
        // 名字，清除時機在所有「離開主戰」的地方（撤退/KO換人/board_switch），見那些地方的
        // stackBuffName=null設定
        if (attacker.stackBuffName === atk.name) mainDamage += (attacker.stackBuffAmount || 0);
        mainDamage += pocketPassiveDamageBonus(attacker, side); // 被動特性：Fighting Coach/Power Link/Cursed Metal這類「全隊加傷」
        mainDamage += pocketToolDamageBonus(attacker, side); // Beastite：依分數加傷
        // Morgrem/Ledian（2026-08-08新增）：「這次攻擊的傷害不受對手身上任何效果影響」——完全跳過
        // 弱點以外(Ledian額外跳過弱點)、被動減傷/Tool減傷/selfShield這幾個defender方的計算
        const ignoreWeak = ctx.ignoreDefenderWeakness;
        const weak = ignoreWeak ? null : (defender.weaknesses || []).find(w => (attacker.types || []).includes(w.type));
        if (weak && defender.noWeaknessUntilTurn !== G.turnNumber) {
          // Bounded Field（2026-08-08新增場地卡）：把弱點從「固定+20」改成「傷害直接×2」，
          // 限定攻擊者不是Mega Evolution Pokémon ex——這張卡場上時全部符合條件的攻擊都適用，
          // 不分是哪一方打出這張場地卡（場地卡本來就沒有陣營之分）
          const isMegaEx = attacker.ex && attacker.name.startsWith('Mega ');
          if (G.activeStadium?.id === 'B3-155' && !isMegaEx) mainDamage *= 2;
          else mainDamage += parseInt(String(weak.value).replace(/\D+/g, ''), 10) || 0;
        }
        // Arena of Antiquity（2026-08-08新增場地卡）：雙方鬥屬性寶可夢攻擊對手主戰ex+20傷害，
        // 場地卡沒有陣營之分，只看attacker/defender本身的屬性/ex，不分是誰打出這張場地卡
        if (G.activeStadium?.id === 'B3-154' && (attacker.types || []).includes('Fighting') && defender.ex) mainDamage += 20;
        // Cheren（2026-08-08新增）：指名寶可夢在對手下回合對ex攻擊的傷害減免，掛在defenderSide
        // （承受攻擊的一方）身上，跟dmgDebuffUntilTurn（掛在attacker身上）方向不同
        if (oppSide.defShieldUntilTurn === G.turnNumber && oppSide.defShieldNames?.includes(defender.name) && (!oppSide.defShieldExOnly || attacker.ex)) {
          mainDamage = Math.max(0, mainDamage - oppSide.defShieldAmount);
        }
        if (defender.dmgDebuffUntilTurn === G.turnNumber) mainDamage = Math.max(0, mainDamage - defender.dmgDebuffAmount);
        // Kommo-o（2026-08-08新增）：跟dmgDebuffUntilTurn方向相反，這是「自己下回合被攻擊時+N傷害」
        // 的自我犧牲型debuff，掛在defender（承受這次攻擊的一方）身上
        if (defender.selfVulnUntilTurn === G.turnNumber) mainDamage += defender.selfVulnAmount;
        if (!ctx.ignoreDefenderEffects) {
          // 被動特性：Fur Coat/Thick Fat/Resilience Link這類「自己減傷/免疫」，Infinity代表完全免疫
          // Tool：Steel Apron/Heavy Helmet/Metal Core Barrier這類固定減傷，跟被動特性的減傷加總扣
          // Beast Wall（2026-08-08新增）：side層級的時限減傷，只保護defenderSide場上的Ultra Beast
          const beastWallReduction = (oppSide.ultraBeastShieldUntilTurn === G.turnNumber && pocketIsUltraBeast(defender)) ? (oppSide.ultraBeastShieldAmount || 0) : 0;
          const passiveAbilityReduction = pocketPassiveDamageReduction(defender, oppSide, attacker);
          // 機率型防禦特性（Guarded Grill/Celestial Blessing/Carefree Steps/Disguise）：這幾個
          // 是擲硬幣後才知道有沒有生效，`passiveAbilityReduction`算出來非0就代表這次真的擲中了，
          // 拿來當作「要不要顯示卡牌發動」的判斷依據
          if (passiveAbilityReduction > 0 && defender.abilities?.[0]?.name) pocketEmitCardActivation(G, op, defender, `特性觸發：${defender.abilities[0].name}`);
          const passiveReduction = passiveAbilityReduction + pocketToolDamageReduction(defender) + beastWallReduction;
          // Mr. Mime/Cosmoem/Chansey等（2026-08-08新增selfShield機制）：「下回合被攻擊時-N傷害」，
          // 跟dmgDebuffUntilTurn（attacker自己招式效果種下的debuff）不同來源，這是defender自己種的
          // 保護——selfShieldCondition可選'ex'/'basic'限定只對特定種類的attacker生效
          let selfShield = 0;
          if (defender.selfShieldUntilTurn === G.turnNumber) {
            const cond = defender.selfShieldCondition;
            if (!cond || (cond === 'ex' && attacker.ex) || (cond === 'basic' && attacker.stage === 'Basic')) selfShield = defender.selfShieldAmount;
          }
          const totalReduction = passiveReduction + (passiveReduction === Infinity ? 0 : selfShield);
          mainDamage = (passiveReduction === Infinity || selfShield === Infinity) ? 0 : Math.max(0, mainDamage - totalReduction);
        }
        defender.curHp = Math.max(0, (defender.curHp ?? defender.hp ?? 0) - mainDamage);
        // Alolan Sandslash/Togedemaru/Turtonator/Chesnaught（2026-08-08新增retaliate機制）：
        // 「下回合被攻擊打中時反傷N給攻擊者」，時效綁定在defender身上，跟pocketPassiveOnHit的
        // 特性反傷不同來源（那是常駐特性，這是招式種下的限時debuff），兩者互不衝突可疊加
        if (mainDamage > 0 && defender.retaliateUntilTurn === G.turnNumber) {
          attacker.curHp = Math.max(0, attacker.curHp - defender.retaliateAmount);
        }
        // 被動特性：Counterattack/Rough Skin/Steel Spikes(反傷)、Poison Point(讓attacker中毒)、
        // Bouncy Body(從能量區拿能量附加板凳)——被打中就觸發，不需要defender死亡，掛在mainDamage
        // 結算完、KO判定之前（跟粗糙皮膚那類「防禦方反擊」是同一種時機，這裡是Pocket版本）
        if (mainDamage > 0) {
          // Wobbuffet（2026-08-08新增）：只要主戰被打中就設旗標，不需要死亡（跟lostToAttackLastOppTurn
          // 不同），這裡G.turn恆等於role(攻擊方)，所以對defender所在的oppSide來說這一定是「對手回合」
          if (oppSide.active?.uid === defender.uid) oppSide.tookDamageLastOppTurn = true;
          const onHit = pocketPassiveOnHit(defender, oppSide);
          if (onHit.counterDamage) { attacker.curHp = Math.max(0, attacker.curHp - onHit.counterDamage); pocketEmitCardActivation(G, op, defender, `特性觸發：${defender.abilities?.[0]?.name || ''}`); }
          // 2026-08-13修正：guard原本檢查status==null（等於「完全沒有任何異常狀態才中毒」），
          // 中毒獨立成欄位後改成只檢查「還沒中毒」，不會因為已經睡眠/麻痺/混亂就擋掉中毒——
          // Poison Point類特性的卡面沒有「無異常狀態」這個前提，這裡只是避免重複觸發
          if (onHit.poisonAttacker && !attacker.poisoned) { attacker.poisoned = true; pocketEmitCardActivation(G, op, defender, `特性觸發：${defender.abilities?.[0]?.name || ''}`); }
          // Bouncy Body原文明確是「拿一個{W}水屬性能量」，不是「拿當前能量區不管什麼顏色」——
          // 能量區這回合剛好不是水屬性就沒有水能量可拿，不觸發（跟pocket_attach_energy用掉
          // pendingEnergy後要清空是同一個規則，避免同一份能量被用兩次）
          if (onHit.benchEnergyType && oppSide.bench.length && oppSide.pendingEnergy === onHit.benchEnergyType) {
            oppSide.bench[0].energy.push(oppSide.pendingEnergy);
            oppSide.pendingEnergy = null;
            pocketEmitCardActivation(G, op, defender, `特性觸發：${defender.abilities?.[0]?.name || ''}`);
          }
          // Tool：Rocky Helmet反傷20、Poison Barb讓攻擊者中毒、Dark Pendant讓攻擊方(side)
          // 隨機公開1張手牌並洗回牌庫——跟被動特性onHit同一個時機，兩套系統的效果直接疊加
          const toolOnHit = pocketToolOnHit(defender);
          if (toolOnHit.counterDamage) { attacker.curHp = Math.max(0, attacker.curHp - toolOnHit.counterDamage); pocketEmitToolActivation(G, op, defender.tool, '裝備效果觸發'); }
          if (toolOnHit.poisonAttacker && !attacker.poisoned) { attacker.poisoned = true; pocketEmitToolActivation(G, op, defender.tool, '裝備效果觸發'); }
          if (toolOnHit.revealShuffleOpp && side.hand.length) {
            const idx = Math.floor(Math.random() * side.hand.length);
            const [card] = side.hand.splice(idx, 1);
            side.deck.push(card);
            side.deck = pocketShuffle(side.deck);
            pocketEmitToolActivation(G, op, defender.tool, '裝備效果觸發');
          }
        }
      }
      if (ctx.selfDamage) attacker.curHp = Math.max(0, attacker.curHp - ctx.selfDamage);
      if (ctx.healMirror && mainDamage > 0 && !pocketHasHealBlock(G)) {
        const before = attacker.curHp;
        attacker.curHp = Math.min(attacker.hp, attacker.curHp + mainDamage);
        ctx.healUid = attacker.uid; ctx.healAmount = attacker.curHp - before;
      }

      // 攻擊事件紀錄——client端用seq判斷是不是「新的」一次攻擊，藉此播放屬性特效/擲硬幣動畫/
      // 傷害飄字，seq在每次真正攻擊都遞增，state broadcast頻繁但這個值不常變，client不會重複播放
      const preCoinFlips = [wakeCoinFlip, confusionCoinFlip, flipLockCoinFlip].filter(v => v != null);
      const coinFlips = preCoinFlips.length ? [...preCoinFlips, ...(ctx.coinFlips || [])] : (ctx.coinFlips || null);
      G.lastEvent = {
        seq: ++G.eventSeq, kind: 'attack', attackerRole: role, atkType: atk.type,
        attackerUid: attacker.uid, targetUid: defender.uid, damage: mainDamage,
        selfDamage: ctx.selfDamage || 0, coinFlips,
        healUid: ctx.healUid || null, healAmount: ctx.healAmount || 0,
      };

      // 板凳濺傷造成的擊倒先處理（不會觸發forced_switch，因為主戰沒被打）
      pocketResolveBenchKOs(G, oppSide, role);
      pocketResolveBenchKOs(G, side, op); // 例如Raging Thunder自己的板凳也可能被自己招式波及

      // 2026-08-08修正：interactive旗標——如果這次peek緊接著會有互動選擇(ctx.needsChoice，
      // 例如Mega Absol ex揭露對手手牌後要選1張支援者棄置)，client端不該再疊一個唯讀的
      // showPeek彈窗在上面（原本z-index比互動選擇框高，會直接蓋住玩家真正要點選的畫面，
      // 使用者只看到「揭露手牌」卻進不去「選一張棄置」那步）。單純揭露、沒有後續選擇的
      // 效果（例如"Your opponent reveals their hand."沒有接choose）維持原本的唯讀彈窗顯示。
      if (ctx.peekOpponentHand) send(ws, { type: 'pocket_peek', title: '對手手牌', cards: oppSide.hand, interactive: !!ctx.needsChoice });

      if (pocketCheckWin(G)) { pocketBroadcastState(pRoom); return; }

      let attackerDied0 = !ctx.skipMainDamage && attacker.curHp <= 0 && side.active === attacker;
      let defenderDied = !ctx.skipMainDamage && defender.curHp <= 0 && oppSide.active === defender;
      // Guts：即將被攻擊傷害擊倒時擲硬幣，正面則不被擊倒、殘餘HP強制變成10——要在KO觸發特性
      // /雙殺判斷之前處理，一旦生效這隻就不算「死亡」，後面所有分支自然不會走到
      if (defenderDied && defender.abilities?.[0]?.name === 'Guts' && pocketFlipCoin({ G, role: op })) {
        defender.curHp = 10; defenderDied = false;
        pocketEmitCardActivation(G, op, defender, '特性觸發：Guts');
      }
      if (attackerDied0 && attacker.abilities?.[0]?.name === 'Guts' && pocketFlipCoin({ G, role })) {
        attacker.curHp = 10; attackerDied0 = false;
        pocketEmitCardActivation(G, role, attacker, '特性觸發：Guts');
      }
      // Hala（2026-08-08新增，支援者卡）：跟Guts同一種「KO-prevention→HP變10」機制，差別是
      // 這個沒有擲硬幣（卡面沒寫flip a coin，是必定生效）、限定持有者名字是Hariyama/Crabominable、
      // 而且只在「對手上一次打出Hala」設定的時效內（oppSide.halaProtectUntilTurn，見TRAINER_EFFECTS
      // 的'B1-222'），不是永久特性
      if (defenderDied && ['Hariyama', 'Crabominable'].includes(defender.name) && oppSide.halaProtectUntilTurn === G.turnNumber) {
        defender.curHp = 10; defenderDied = false;
        pocketEmitCardActivation(G, op, defender, 'Hala效果生效');
      }
      // Lucky Mittens（2026-08-07新增Tool）：裝備者的攻擊擊倒對手主戰時，裝備者的擁有者抽1張牌
      // ——不管attacker自己這次交鋒有沒有也一起死掉（雙殺），只要defender真的被這次攻擊打倒就算
      if (defenderDied && attacker.tool?.id === 'B1-220' && side.deck.length > 0) {
        side.hand.push(side.deck.shift());
      }
      // Lucky Egg（2026-08-08新增Tool）：裝備者被對手攻擊擊倒時，擁有者抽牌到手牌5張——跟
      // Lucky Mittens同一種「defender死於這次攻擊時觸發」時機，只是抽牌方向相反（defender自己
      // 這一側受益，不是attacker那一側）
      if (defenderDied && defender.tool?.id === 'B3-148') {
        while (oppSide.hand.length < 5 && oppSide.deck.length) oppSide.hand.push(oppSide.deck.shift());
      }
      // 被KO觸發型特性（2026-08-07新增，第六種觸發時機）：只在defender真的死於這次攻擊、且是
      // 在主戰位置時觸發——可能連帶讓attacker也死亡（反傷/機率致死），所以要在「重新計算一次
      // attackerDied」之前處理，讓底下既有的雙殺/單獨死亡分支能正確吃到這裡造成的新死亡。
      // 對已經死掉的attacker（原本就雙殺）套用這些效果是安全的no-op（Math.max(0,curHp-50)
      // 對curHp已是0的情況還是0，不會產生負數或任何異常）。
      let awardPointForDefender = true;
      if (defenderDied) {
        const defAbility = defender.abilities?.[0]?.name;
        if (defAbility === 'Innards Out') {
          attacker.curHp = Math.max(0, attacker.curHp - 50);
          pocketEmitCardActivation(G, op, defender, '特性觸發：Innards Out');
        } else if (defAbility === 'Perish Body') {
          if (pocketFlipCoin({ G, role: op })) { attacker.curHp = 0; pocketEmitCardActivation(G, op, defender, '特性觸發：Perish Body'); }
        } else if (defAbility === 'Offload Pass' && oppSide.bench.length) {
          const fEnergy = defender.energy.filter(e => e === 'Fighting');
          if (fEnergy.length) { defender.energy = defender.energy.filter(e => e !== 'Fighting'); oppSide.bench[0].energy.push(...fEnergy); pocketEmitCardActivation(G, op, defender, '特性觸發：Offload Pass'); }
        } else if (defAbility === 'Final Scream') {
          // 2026-08-09修正：這是defender(對手)的特性打到攻擊方整隊，板凳上裝Protective
          // Poncho/Shell Shield的原本完全沒被保護到——這條路徑是KO觸發型特性，不是走
          // effectFn(ctx)那套snapshot/enforce包裝，之前漏了單獨補這個判斷
          const isBench = p => side.bench.includes(p);
          [side.active, ...side.bench].filter(Boolean).forEach(p => {
            if (p.curHp > 0 && !pocketBenchDamageImmune(p, isBench(p))) p.curHp = Math.max(0, p.curHp - 10);
          });
          pocketEmitCardActivation(G, op, defender, '特性觸發：Final Scream');
        } else if (defAbility === 'Fade into Darkness' && pocketFlipCoin({ G, role: op })) {
          awardPointForDefender = false; // 只套用在單獨defenderDied分支，雙殺情境維持既有pocketResolveMutualKO不變（範圍刻意限縮，避免雙重特殊規則疊加）
          pocketEmitCardActivation(G, op, defender, '特性觸發：Fade into Darkness');
        } else if (defAbility === 'Shattering Crystal' && pocketFlipCoin({ G, role: op })) {
          // 跟Fade into Darkness同一種「被擊倒時擲硬幣擋對手得分」機制，只是卡名不同
          awardPointForDefender = false;
          pocketEmitCardActivation(G, op, defender, '特性觸發：Shattering Crystal');
        }
        // Illusive Trickery：跟上面幾個「defender被KO時defender自己的特性觸發」方向不同，
        // 這是「attacker用自己的招式擊倒對手」時attacker自己的特性——沿用既有invulnerableUntilTurn
        // 機制（跟其他「下回合完全免疫傷害+效果」的招式效果共用同一個旗標跟判定點），如果attacker
        // 這次也雙殺死了，設在已死的instance上是安全的no-op（下回合它已經不在場上，不會被讀到）
        if (attacker.abilities?.[0]?.name === 'Illusive Trickery') {
          attacker.invulnerableUntilTurn = G.turnNumber + 1;
          pocketEmitCardActivation(G, role, attacker, '特性觸發：Illusive Trickery');
        }
        // Rampardos（2026-08-08補上，原本因為需要「攻擊當下就知道這次會不會KO」而判斷要獨立
        // 事後掛鉤才跳過——其實跟Innards Out這批「defender被KO時觸發後續效果」是同一個時機，
        // 只是觸發條件換成attacker自己的招式效果(ctx.selfDamageIfDefenderKO)而不是defender的
        // 特性，用同一個defenderDied區塊處理即可，不需要真的另開一個「事後」hook
        if (ctx.selfDamageIfDefenderKO) attacker.curHp = Math.max(0, attacker.curHp - ctx.selfDamageIfDefenderKO);
      }
      const attackerDied = attackerDied0 || (!ctx.skipMainDamage && attacker.curHp <= 0 && side.active === attacker);
      // Aerodactyl的「洗回牌庫」效果已經在effect handler內自己呼叫過pocketResolveActiveKO(false)，
      // 這裡如果已經進入forced_switch/done就不要再往下走
      if (G.phase === 'forced_switch' || G.phase === 'done') { pocketBroadcastState(pRoom); return; }

      // 2026-08-12修正：needsChoice的檢查要搬到KO判斷「之前」——原本KO分支(mutual/attacker/
      // defender死亡)各自直接return，如果這次攻擊「傷害本身就KO了對方」同時「效果又需要玩家
      // 自選」（例如超級阿勃梭魯ex「黑暗之爪」：80傷害可能直接打死對手主戰，但效果還要選1張
      // 對手手牌的支援者卡棄掉），needsChoice永遠執行不到、效果整個消失（使用者回報「使用
      // 招式時不會發動他的效果」）。修法：needsChoice優先暫停，KO資訊存進deferredKO，等玩家
      // 選完（pocket_attack_choice）才真正執行KO，見pocketResolveDeferredKO的完整說明。
      if (ctx.needsChoice) {
        G.phase = 'attack_choice';
        G.pendingChoice = {
          role, ...ctx.needsChoice,
          deferredKO: (attackerDied || defenderDied)
            ? { attackerDied, defenderDied, awardPointForDefender, attackerRole: role, defenderRole: op }
            : null,
        };
        pocketBroadcastState(pRoom);
        return;
      }

      if (attackerDied && defenderDied) {
        // 雙殺（例如Golem的Double-Edge：反傷打死自己同時擊倒對手；或上面新增的Innards Out/
        // Perish Body反過來把attacker也拖下水）——見pocketResolveMutualKO註解
        pocketResolveMutualKO(G, role, op);
        pocketBroadcastState(pRoom); return;
      }
      if (attackerDied) {
        // 自傷/自損打死自己（例如波導彈/雙倍拳頭）——一樣算作被擊倒，對方加分
        pocketResolveActiveKO(G, role);
        pocketBroadcastState(pRoom); return;
      }
      if (defenderDied) {
        pocketResolveActiveKO(G, op, awardPointForDefender);
        // Iris（2026-08-08新增）：本回合用過這張卡+這次是自己的Haxorus打的攻擊造成KO，額外+1分
        if (awardPointForDefender && side.irisBonusThisTurn && attacker.name === 'Haxorus') side.points += 1;
        // Final Scream可能也波及了side（attacker這一方）的板凳——招式本身的濺傷已經在更早的
        // pocketResolveBenchKOs呼叫處理過，這裡是Final Scream額外造成的，要再檢查一次
        pocketResolveBenchKOs(G, side, op);
        pocketBroadcastState(pRoom); return;
      }

      pocketAdvanceTurn(G);
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_attack_choice') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'attack_choice') return;
      const G = pRoom.G; const role = ws.pocketRole;
      const pending = G.pendingChoice;
      if (!pending || pending.role !== role) return;
      const side = G[role];
      if (pending.kind === 'energy_distribute') {
        if (!pending.eligibleUids.includes(msg.uid)) return;
        const pool = pending.includeActive ? [side.active, ...side.bench] : side.bench;
        const target = pool.find(p => p && p.uid === msg.uid);
        if (!target) return;
        target.energy.push(pending.energyQueue.shift());
        if (pending.energyQueue.length > 0) { pocketBroadcastState(pRoom); return; }
      } else if (pending.kind === 'bench_switch') {
        // 2026-08-07擴充：加了可選的eligibleUids篩選（例如「跟1隻電系板凳互換」這種限定屬性的
        // 版本），沒帶這個欄位的舊卡（純粹「跟1隻板凳互換」不限屬性）維持全板凳皆可選
        if (pending.eligibleUids && !pending.eligibleUids.includes(msg.uid)) return;
        const idx = side.bench.findIndex(p => p.uid === msg.uid);
        if (idx < 0) return;
        const bench = side.bench[idx];
        const attacker = side.active;
        attacker.status = null; attacker.poisoned = false; attacker.burned = false; // 離開主戰要清除全部異常狀態（含中毒/灼傷）
        attacker.stackBuffName = null; attacker.stackBuffAmount = 0; // Miltank/Mega Mawile ex
        bench.enteredActiveThisTurn = G.turnNumber; // Golisopod/Scizor/Basculin
        side.bench[idx] = attacker;
        side.active = bench;
      } else if (pending.kind === 'retreat_discard') {
        // 2026-08-12新增：撤退時玩家自選要棄哪個能量，見pocket_retreat handler跟
        // pocketFinalizeRetreat的說明——這裡跟其餘pendingChoice分支不同，退場本身不算
        // 結束回合，所以自己early return，不落到最下面共用的pocketAdvanceTurn收尾
        if (!msg.energyType || !side.active.energy.includes(msg.energyType)) return;
        side.active.energy.splice(side.active.energy.indexOf(msg.energyType), 1);
        side.discardEnergy.push(msg.energyType);
        pending.remaining--;
        if (pending.remaining > 0) { pocketBroadcastState(pRoom); return; }
        const benchUid = pending.benchUid;
        G.pendingChoice = null;
        G.phase = 'active';
        pocketFinalizeRetreat(G, role, benchUid);
        pocketBroadcastState(pRoom);
        return;
      } else if (pending.kind === 'attack_discard_energy') {
        // 2026-08-15新增：招式效果「棄掉這隻身上的能量」但卡面沒寫random，玩家自選要棄哪個——
        // 跟retreat_discard同一套UI/解析邏輯，差別是棄完不用呼叫pocketFinalizeRetreat，直接落到
        // 下面共用收尾（正常結束回合）
        if (!msg.energyType || !side.active.energy.includes(msg.energyType)) return;
        side.active.energy.splice(side.active.energy.indexOf(msg.energyType), 1);
        side.discardEnergy.push(msg.energyType);
        pending.remaining--;
        if (pending.remaining > 0) { pocketBroadcastState(pRoom); return; }
      } else if (pending.kind === 'pick_target' && pending.optional && msg.skip) {
        // 2026-08-09新增：optional的pick_target允許玩家不選任何目標直接跳過——目前只有
        // discardForBoost(Vespiquen ex「可以棄1隻板凳換多傷害，不棄也可以」)用到，卡面是
        // "you may"不是強制。擺在一般pick_target分支之前優先攔截msg.skip，不動到既有分支
        // 內容；base傷害已經在pocket_attack當下打完，這裡什麼都不用做，直接落到下面的共用
        // 收尾（清pendingChoice+結束回合）。
      } else if (pending.kind === 'pick_target') {
        // 通用「1 of your (opponent's) (Benched) Pokémon」目標選擇——pool='ownBench'只能選
        // 自己板凳，pool='oppAll'可以選對手主戰+板凳（例如打對手任一寶可夢的攻擊效果）
        if (!pending.eligibleUids.includes(msg.uid)) return;
        const op = role === 'p1' ? 'p2' : 'p1';
        const oppSide = G[op];
        // pool='oppHand'（2026-08-07新增）：目標不是board上的寶可夢，是「對方公開的手牌」裡的
        // 一張卡（"Your opponent reveals their hand. Choose a Supporter card..."這類效果）——
        // action是'discard'或'shuffleIntoDeck'，跟其他pool的傷害/治療/附能量完全不同的動作種類
        if (pending.pool === 'oppHand') {
          if (!pending.eligibleUids.includes(msg.uid)) return;
          const idx = oppSide.hand.findIndex(c => c.uid === msg.uid);
          if (idx < 0) return;
          const [card] = oppSide.hand.splice(idx, 1);
          if (pending.action === 'discard') oppSide.discard.push(card);
          else if (pending.action === 'shuffleIntoDeck') { oppSide.deck.push(card); oppSide.deck = pocketShuffle(oppSide.deck); }
          // 2026-08-12新增：deferredKO——見pocketResolveDeferredKO的說明，這次攻擊的傷害本身
          // 可能已經把attacker/defender打死，要等這個選擇解析完才真正執行KO
          const deferredKO = pending.deferredKO;
          G.pendingChoice = null;
          G.phase = 'active';
          if (pocketResolveDeferredKO(G, pRoom, deferredKO)) return;
          pocketAdvanceTurn(G);
          pocketBroadcastState(pRoom);
          return;
        }
        // pool='ownDiscardSupporter'（2026-08-07新增，Search for Friends）：目標不是board上
        // 的寶可夢，是自己棄牌堆裡的一張支援者卡，跟oppHand同一種「操作卡片而非寶可夢」的分支，
        // 但這裡noEndTurn一定是true（進化觸發不結束回合），不像oppHand那些攻擊觸發的固定結束回合
        if (pending.pool === 'ownDiscardSupporter') {
          if (!pending.eligibleUids.includes(msg.uid)) return;
          const idx = side.discard.findIndex(c => c.uid === msg.uid);
          if (idx < 0) return;
          const [card] = side.discard.splice(idx, 1);
          side.hand.push(card);
          G.pendingChoice = null;
          G.phase = 'active';
          if (!pending.noEndTurn) pocketAdvanceTurn(G);
          pocketBroadcastState(pRoom);
          return;
        }
        const target = pending.pool === 'oppAll'
          ? [oppSide.active, ...oppSide.bench].find(p => p && p.uid === msg.uid)
          : pending.pool === 'ownAll'
          ? [side.active, ...side.bench].find(p => p && p.uid === msg.uid)
          : side.bench.find(p => p.uid === msg.uid);
        if (!target) return;
        if (pending.action === 'attachEnergy') {
          for (let i = 0; i < (pending.count || 1); i++) target.energy.push(pending.energyType);
        } else if (pending.action === 'moveAllEnergyFromAttacker') {
          // Swanna/Mismagius（2026-08-08新增）：把攻擊者(side.active，此刻還沒變過)身上全部
          // （或篩選特定屬性，見energyFilter）能量移給玩家選的板凳寶可夢
          const src = side.active;
          if (src) {
            const moving = pending.energyFilter ? src.energy.filter(e => e === pending.energyFilter) : [...src.energy];
            src.energy = pending.energyFilter ? src.energy.filter(e => e !== pending.energyFilter) : [];
            target.energy.push(...moving);
          }
        } else if (pending.action === 'heal') {
          if (!pocketHasHealBlock(G)) target.curHp = Math.min(target.hp, target.curHp + pending.amount);
        } else if (pending.action === 'setDelayedDamage') {
          // Meowscarada（2026-08-08新增，已知簡化見ATTACK_EFFECTS該條註解）：跟Mismagius共用
          // 同一個delayedDamageUntilTurn/Amount機制，只是這裡多一層「玩家先選目標」的暫停
          target.delayedDamageUntilTurn = G.turnNumber + 1;
          target.delayedDamageAmount = pending.amount;
          target.delayedDamageExOrigin = !!side.active?.ex; // 花舞鳥「神秘守護」引爆時判斷用的快照
        } else if (pending.action === 'switchInAndDamage') {
          // Pull In and Pound（2026-08-08新增）：把玩家選的對手板凳寶可夢拉上主戰，直接對牠造成
          // 傷害——跟一般damage分支不同的地方是「target」原本在板凳，要先真的換上主戰才打
          const idx = oppSide.bench.findIndex(p => p.uid === target.uid);
          if (idx >= 0) {
            oppSide.bench.splice(idx, 1);
            if (oppSide.active) { oppSide.active.status = null; oppSide.active.poisoned = false; oppSide.active.burned = false; oppSide.bench.push(oppSide.active); }
            oppSide.active = target;
          }
          if (!pocketSafeguardImmune(target, side.active)) target.curHp = Math.max(0, target.curHp - pending.amount);
          pocketResolveBenchKOs(G, oppSide, role);
          if (target.curHp <= 0) pocketResolveActiveKO(G, op);
          if (pocketCheckWin(G)) { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
          if (G.phase === 'forced_switch' || G.phase === 'done') { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
        } else if (pending.action === 'damage' || pending.action === 'damagePerEnergy') {
          const amount = pending.action === 'damagePerEnergy' ? target.energy.length * pending.perEnergy : pending.amount;
          // 花舞鳥「神秘守護」：卡面文字限定「對手ex的招式」才擋，訓練師卡/特性造成的傷害不算——
          // 這個pick_target/action:'damage'流程是ATTACK_EFFECTS、TRAINER_EFFECTS、
          // EVOLVE_TRIGGER_ABILITIES共用的同一段解析程式碼，用pending.deferredKO是否存在（只有
          // pocket_attack那個handler會固定加這個key，其餘來源不會）判斷這次選擇是不是真的來自
          // 攻擊，不是訓練師卡/特性效果。同時只有pool==='oppAll'時target才是對手的寶可夢——自己
          // 這一側的target（'ownAll'/'ownBench'，自傷效果）攻擊者跟target同隊，不算「對手的ex」
          const immune = pending.pool === 'oppAll' && pending.deferredKO !== undefined && pocketSafeguardImmune(target, side.active);
          if (!immune) target.curHp = Math.max(0, target.curHp - amount);
          // 這個分支的傷害延遲到玩家選完目標才真的套用，跟一般攻擊在pocket_attack當下就結算
          // 不一樣——原本的pocketResolveBenchKOs/pocketResolveActiveKO/pocketCheckWin是攻擊當下
          // 就跑過一次，這裡打的傷害那次還沒發生，所以要自己再補一次KO跟勝負判定，不然打死
          // 目標會卡在場上變殭屍卡（或者主戰死亡時沒進forced_switch）、該加分的一方也沒拿到分。
          if (pending.pool === 'oppAll') {
            pocketResolveBenchKOs(G, oppSide, role);
            if (oppSide.active?.uid === target.uid && target.curHp <= 0) pocketResolveActiveKO(G, op);
          } else {
            pocketResolveBenchKOs(G, side, op);
          }
          if (pocketCheckWin(G)) { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
          if (G.phase === 'forced_switch' || G.phase === 'done') { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
        } else if (pending.action === 'discardForBoost') {
          // Vespiquen ex「Chase Order」：base傷害已經在pocket_attack當下正常結算過（打的是
          // 固定的defender，不是玩家選的），這裡只處理「棄掉選中的板凳寶可夢」+補上額外傷害，
          // 跟damage/damagePerEnergy同一種「延遲生效，自己重跑KO/勝負判定」模式
          side.bench = side.bench.filter(p => p.uid !== target.uid);
          side.discard.push(target);
          const defender = oppSide.active;
          if (defender) {
            defender.curHp = Math.max(0, defender.curHp - pending.boostAmount);
            pocketResolveBenchKOs(G, oppSide, role);
            if (oppSide.active?.uid === defender.uid && defender.curHp <= 0) pocketResolveActiveKO(G, op);
            if (pocketCheckWin(G)) { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
            if (G.phase === 'forced_switch' || G.phase === 'done') { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
          }
        }
      } else if (pending.kind === 'pick_move') {
        // 「Choose 1 of your opponent's Active Pokémon's attacks and use it as this attack.」
        // ——2026-08-07新增。簡化實作：只套用借來招式的固定傷害數字+弱點加成，不重新跑完整
        // 的乘法鏈（場地/被動特性/buff/Tool等全部略過）——這個引擎的弱點判定本來就是查
        // 「攻擊方寶可夢自己的種族屬性」(attacker.types)而不是招式屬性，借用招式不影響
        // 這個判定基準，直接沿用即可。跟pick_target的action:'damage'分支一樣，KO/勝負判定
        // 要自己重跑一次（這次傷害延遲到玩家選完招式才真的套用）。
        const op = role === 'p1' ? 'p2' : 'p1';
        const oppSide = G[op];
        const attacker = side.active;
        // Ditto（2026-08-08新增）：跟一般pick_move借「對手主戰」的招式方向不同，這是借「自己
        // 板凳」上任一隻的招式——多一層「先選哪隻寶可夢」，client端把uid跟moveIndex一起送，
        // borrowSource固定用msg.uid查自己板凳（跟oppSide.active方向相反），不能選ex（卡面排除）
        const borrowSource = pending.pool === 'ownBench' ? side.bench.find(p => p.uid === msg.uid && !p.ex) : null;
        const defender = oppSide.active;
        if (!attacker || !defender) { G.pendingChoice = null; G.phase = 'active'; pocketBroadcastState(pRoom); return; }
        if (pending.pool === 'ownBench' && !borrowSource) return; // 不合法的來源（不是板凳上的、或選到ex），維持pendingChoice等玩家重選
        const borrowedAtk = (pending.pool === 'ownBench' ? borrowSource : defender).attacks?.[msg.moveIndex];
        if (!borrowedAtk) return; // 不合法的招式索引，維持pendingChoice等玩家重選
        // 部分卡面版本多了「沒有必要能量就完全沒效果」的條件，跟一般攻擊事前擋下不同——這裡
        // 是「選了才知道要不要付得起」，付不起就直接結束回合、什麼都不做（不是拒絕這次選擇）
        if (pending.checkEnergy && !pocketCanPayCost(attacker, borrowedAtk.cost || [], side)) {
          G.pendingChoice = null;
          G.phase = 'active';
          pocketAdvanceTurn(G);
          pocketBroadcastState(pRoom);
          return;
        }
        let dmg = parseInt(String(borrowedAtk.damage || '0').replace(/\D+/g, ''), 10) || 0;
        const weak = (defender.weaknesses || []).find(w => (attacker.types || []).includes(w.type));
        if (weak) dmg += parseInt(String(weak.value).replace(/\D+/g, ''), 10) || 0;
        defender.curHp = Math.max(0, defender.curHp - dmg);
        pocketResolveBenchKOs(G, oppSide, role);
        if (pocketCheckWin(G)) { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
        if (oppSide.active?.uid === defender.uid && defender.curHp <= 0) {
          pocketResolveActiveKO(G, op);
          G.pendingChoice = null;
          pocketBroadcastState(pRoom);
          return;
        }
      } else if (pending.kind === 'pick_target_multi') {
        // 「Choose N of your Benched Pokémon」——跟pick_target不同的是要選N隻「不同的」，
        // 選過的要從候選池排除，避免同一隻重複選好幾次
        if (!pending.eligibleUids.includes(msg.uid)) return;
        const target = side.bench.find(p => p.uid === msg.uid);
        if (!target) return;
        target.energy.push(pending.energyType);
        pending.eligibleUids = pending.eligibleUids.filter(u => u !== msg.uid);
        pending.remaining--;
        if (pending.remaining > 0 && pending.eligibleUids.length > 0) { pocketBroadcastState(pRoom); return; }
      } else if (pending.kind === 'pick_hand_multi') {
        // May（2026-08-08新增）：選N張自己手牌洗回牌庫——跟pick_target_multi同一種「選N個、
        // 選過的要排除」結構，但操作對象是手牌卡片不是board寶可夢，候選池在觸發當下（已經先
        // 把2張隨機寶可夢放進手牌之後）才算出來，玩家能看到真正抽到了什麼再決定要洗掉哪2張
        if (!pending.eligibleUids.includes(msg.uid)) return;
        const idx = side.hand.findIndex(c => c.uid === msg.uid);
        if (idx < 0) return;
        const [card] = side.hand.splice(idx, 1);
        side.deck.push(card);
        pending.eligibleUids = pending.eligibleUids.filter(u => u !== msg.uid);
        pending.remaining--;
        if (pending.remaining > 0 && pending.eligibleUids.length > 0) { pocketBroadcastState(pRoom); return; }
        side.deck = pocketShuffle(side.deck);
        // Maintenance（2026-08-13新增）：洗完立刻抽N張——通用的opt-in欄位，May沒設這個欄位
        // 所以行為不變，只有明確要求「洗完再抽」的效果才會用到
        if (pending.drawAfter) {
          for (let i = 0; i < pending.drawAfter && side.deck.length; i++) side.hand.push(side.deck.shift());
        }
      } else if (pending.kind === 'pick_target_multi_optional') {
        // Gyarados「Wild Swing」（2026-08-12新增）：跟pick_target_multi不同，這裡的「棄幾隻」
        // 由玩家自己決定（0~全部候選），不是固定N——一次把整批選好的uid送過來(msg.uids)，
        // 不是像pick_target_multi那樣一次選1隻、選完扣remaining直到0才收尾。base傷害已經在
        // pocket_attack當下正常結算過，這裡只處理「棄掉選中的每一隻」+補上對應加成傷害，
        // 跟discardForBoost（Vespiquen ex，固定棄1隻）同一種「延遲生效，自己重跑KO/勝負判定」模式。
        const uids = Array.isArray(msg.uids) ? [...new Set(msg.uids)] : [];
        const validUids = uids.filter(u => pending.eligibleUids.includes(u));
        const discarded = [];
        validUids.forEach(u => {
          const idx = side.bench.findIndex(p => p.uid === u);
          if (idx >= 0) { const [p] = side.bench.splice(idx, 1); side.discard.push(p); discarded.push(p); }
        });
        if (discarded.length) {
          const op2 = role === 'p1' ? 'p2' : 'p1';
          const oppSide2 = G[op2];
          const defender = oppSide2.active;
          if (defender) {
            defender.curHp = Math.max(0, defender.curHp - discarded.length * pending.boostPerPick);
            pocketResolveBenchKOs(G, oppSide2, role);
            if (oppSide2.active?.uid === defender.uid && defender.curHp <= 0) pocketResolveActiveKO(G, op2);
            if (pocketCheckWin(G)) { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
            if (G.phase === 'forced_switch' || G.phase === 'done') { G.pendingChoice = null; pocketBroadcastState(pRoom); return; }
          }
        }
      } else {
        return;
      }
      // 2026-08-12新增：deferredKO——見pocketResolveDeferredKO的說明，這批共用收尾涵蓋
      // energy_distribute/bench_switch/pick_target(一般board目標)/pick_target_multi/
      // pick_hand_multi等分支，理論上也可能跟「傷害本身就KO」同時發生（例如Vespiquen ex
      // 那種optional加傷選擇），一併處理，不只oppHand那個分支
      const deferredKO = pending.deferredKO;
      G.pendingChoice = null;
      G.phase = 'active';
      if (deferredKO && pocketResolveDeferredKO(G, pRoom, deferredKO)) return;
      // noEndTurn：進化觸發型選擇（Healing Ripples/Search for Friends）解析完不能結束回合，
      // 跟其他攻擊觸發的pending（一定會結束回合）用同一個旗標區分，見EVOLVE_TRIGGER_ABILITIES註解
      if (!pending.noEndTurn) pocketAdvanceTurn(G);
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_choose_active') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'forced_switch') return;
      const G = pRoom.G; const role = ws.pocketRole;
      if (G.pendingSwitchRole !== role) return;
      const side = G[role];
      const idx = side.bench.findIndex(p => p.uid === msg.target);
      if (idx < 0) return;
      // 2026-08-12修正：Sabrina這類「把對手主戰換到板凳」效果會設pendingSwitchExcludeUid（見
      // pocketEnterForcedSwitch的說明）——只有板凳真的只剩這隻自己一個選項時才放行選回同一隻，
      // 不然等於這張卡沒發生任何事，使用者回報這個限制原本沒做。
      if (G.pendingSwitchExcludeUid && msg.target === G.pendingSwitchExcludeUid && side.bench.length > 1) {
        send(ws, { type: 'error', message: '不能選擇剛被換下來的這隻，板凳還有其他寶可夢可以選' });
        return;
      }
      const chosen = side.bench[idx];
      side.bench.splice(idx, 1);
      side.active = chosen;
      chosen.enteredActiveThisTurn = G.turnNumber; // Golisopod/Scizor/Basculin條件用（見pocket_retreat同樣的標記）
      // 佇列裡可能還有另一邊在排隊（雙殺情況，見pocketResolveMutualKO）——先換完這個才輪到下一個，
      // 佇列真的清空才算真正離開forced_switch。
      G.pendingSwitchQueue = (G.pendingSwitchQueue || []).filter(r => r !== role);
      if (G.pendingSwitchQueue.length) {
        G.pendingSwitchRole = G.pendingSwitchQueue[0];
      } else {
        G.pendingSwitchRole = null;
        G.phase = 'active';
        // 直接呼叫pocketStartNextTurn，不是重新呼叫pocketAdvanceTurn——多數情況下這次KO換人
        // 是Checkup期間發生的（endingSide自己中毒/燒傷死亡，或本方的Snowy Terrain等特性打死
        // 對方），Checkup只該執行一次；重新跑一次pocketAdvanceTurn會讓中毒/燒傷/回合結束觸發
        // 特性被重複結算一次（新換上場的寶可夢沒有status所以看起來「恰好沒事」，但Snowy
        // Terrain這類「打對方」的特性不會因為對方換人而消失，會被打第二次，是真的bug）。
        // 已知簡化：搏命/雙殺（pocketResolveMutualKO）換人也共用同一個'endTurn' reason，但
        // 那個情境的checkup其實從未執行過（雙殺發生在攻擊當下，不是回合結束）——這裡跳過
        // checkup意味著雙殺換人後，新換上場的寶可夢即使剛好帶有Legendary Pulse/Full-Mouth
        // Manner等「回合結束觸發」特性，這次也不會觸發。刻意接受這個簡化（少觸發一次特性利益）
        // 而不是重跑整個checkup（會導致Snowy Terrain這類「打對方」的效果重複造成傷害）——
        // 兩個選項只能二選一，安全性優先於覆蓋率。
        if (G.pendingSwitchReason === 'endTurn') pocketStartNextTurn(G);
        G.pendingSwitchReason = null;
        G.pendingSwitchExcludeUid = null;
        G.pendingSwitchIsKO = false;
      }
      pocketBroadcastState(pRoom);
      return;
    }

    // 投降（2026-08-10新增）：不限自己回合、不管目前在哪個phase（active/attack_choice/
    // forced_switch都可以）——隨時可以觸發，對手直接判定獲勝。跟其他end-game路徑
    // （pocketResolveActiveKO/pocketResolveMutualKO等）一樣只設G.winner+G.phase='done'，
    // 不用額外清pendingChoice等欄位——client端renderBoard()檢查phase==='done'的順序在
    // 所有pendingChoice相關渲染邏輯之後，broadcast出去的phase已經是'done'就不會再顯示
    // 任何選擇中的UI。
    if (type === 'pocket_surrender') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase === 'done') return;
      const G = pRoom.G; const role = ws.pocketRole;
      if (role !== 'p1' && role !== 'p2') return;
      G.winner = role === 'p1' ? 'p2' : 'p1';
      G.phase = 'done';
      pocketBroadcastState(pRoom);
      return;
    }

    // Mesagoza（2026-08-08新增）：這個引擎第一張「場地卡本身主動觸發」的卡——跟其餘場地卡
    // 都是被動判定（掛在傷害計算式/撤退成本等既有hook）不同，這張需要獨立的按鈕+WS訊息。
    // 「once during each player's turn」＝只有正在行動的一方能觸發，一回合限1次
    if (type === 'pocket_use_stadium') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole;
      if (G.turn !== role) return;
      const stadiumId = G.activeStadium?.id;
      const side = G[role];
      // 2026-08-08新增：Mesagoza原本是唯一的「每回合各自可以觸發1次」場地卡，這次B2b~B4系列
      // 又加了4張同一種句型（"Once during each player's turn, that player may..."），共用同一個
      // 訊息+同一個stadiumUsedThisTurn旗標，只是各自的效果不同——G.turn===role這個檢查本身
      // 就已經讓「輪到誰的回合，誰才能用」自然成立，不用額外分p1/p2判斷
      if (stadiumId === 'B2a-093') { // Mesagoza：擲硬幣，正面隨機1張寶可夢進手牌
        if (side.stadiumUsedThisTurn) { send(ws, { type: 'error', message: '這回合已經用過場地卡效果了' }); return; }
        side.stadiumUsedThisTurn = true;
        // 2026-08-11修正：這整個pocket_use_stadium handler原本完全沒有設定G.lastEvent，
        // Mesagoza的擲硬幣結果對client端來說完全無聲無息（使用者回報「需要有擲硬幣的動畫」）——
        // 跟pocket_attack/pocket_play_item/pocket_use_ability等其餘handler一樣補上lastEvent，
        // client的handlePocketEvent只看evt.coinFlips有沒有值，不挑kind，任何值都能觸發動畫
        const heads = pocketFlipCoin({ G, role });
        G.lastEvent = { seq: ++G.eventSeq, kind: 'stadium', coinFlips: [heads] };
        if (heads && side.deck.length) {
          const idx = Math.floor(Math.random() * side.deck.length);
          side.hand.push(side.deck.splice(idx, 1)[0]);
        }
      } else if (stadiumId === 'B3-153') { // Fragrant Forest：牌庫隨機1張基礎草寶可夢進手牌
        if (side.stadiumUsedThisTurn) { send(ws, { type: 'error', message: '這回合已經用過場地卡效果了' }); return; }
        side.stadiumUsedThisTurn = true;
        const idxs = side.deck.map((c, i) => (c.category === 'Pokemon' && c.stage === 'Basic' && (c.types || []).includes('Grass')) ? i : -1).filter(i => i >= 0);
        if (idxs.length) { const idx = idxs[Math.floor(Math.random() * idxs.length)]; side.hand.push(side.deck.splice(idx, 1)[0]); }
      } else if (stadiumId === 'B3a-074') { // Area Zero：手牌1張基礎寶可夢洗回牌庫，若真的洗了就抽1張
        if (side.stadiumUsedThisTurn) { send(ws, { type: 'error', message: '這回合已經用過場地卡效果了' }); return; }
        // 2026-08-11修正：卡面「may shuffle a Basic Pokémon from their hand」沒有random，原本
        // 用side.hand.find(...)自動挑第一張是誤判成跟Rare Candy一樣的架構限制——其實通用
        // stadium觸發訊息只要多帶一個target欄位（client端先跳手牌選擇器）就能解決，不需要新機制
        const target = side.hand.find(c => c.uid === msg.target && c.category === 'Pokemon' && c.stage === 'Basic');
        if (!target) { send(ws, { type: 'error', message: '請選擇手牌裡要洗回牌庫的基礎寶可夢' }); return; }
        side.stadiumUsedThisTurn = true;
        side.hand = side.hand.filter(c => c.uid !== target.uid);
        side.deck = pocketShuffle([...side.deck, target]);
        if (side.deck.length) side.hand.push(side.deck.shift());
      } else if (stadiumId === 'B3b-069') { // Kid's Room：手牌1張卡跟牌庫隨機1張道具卡交換
        if (side.stadiumUsedThisTurn) { send(ws, { type: 'error', message: '這回合已經用過場地卡效果了' }); return; }
        if (!side.hand.length) { send(ws, { type: 'error', message: '手牌沒有卡可以交換' }); return; }
        const toolIdxs = side.deck.map((c, i) => (c.category === 'Trainer' && c.trainerType === 'Tool') ? i : -1).filter(i => i >= 0);
        if (!toolIdxs.length) { send(ws, { type: 'error', message: '牌庫沒有道具卡可以交換' }); return; }
        // 2026-08-11修正：卡面是「choose a card in their hand」+「a random Pokémon Tool card」
        // ——手牌這邊要玩家自選，牌庫道具卡那邊才是真的random，原本兩邊都隨機挑，手牌那半判斷錯了
        const handIdx = side.hand.findIndex(c => c.uid === msg.target);
        if (handIdx < 0) { send(ws, { type: 'error', message: '請選擇要交換掉的手牌' }); return; }
        side.stadiumUsedThisTurn = true;
        const [handCard] = side.hand.splice(handIdx, 1);
        const toolIdx = toolIdxs[Math.floor(Math.random() * toolIdxs.length)];
        const [toolCard] = side.deck.splice(toolIdx, 1);
        side.hand.push(toolCard);
        side.deck.push(handCard);
        side.deck = pocketShuffle(side.deck);
      } else if (stadiumId === 'B4-155') { // Rainbow Cave：棄掉目前能量區的能量，「下一個能量」直接補上來
        if (side.stadiumUsedThisTurn) { send(ws, { type: 'error', message: '這回合已經用過場地卡效果了' }); return; }
        if (!side.pendingEnergy) { send(ws, { type: 'error', message: '能量區目前沒有能量可以棄掉' }); return; }
        side.stadiumUsedThisTurn = true;
        // 2026-08-08修正：棄掉的能量原本憑空消失，導致Dragon's Blessing之後找不到——
        // 真實規則被棄掉的能量會進棄牌堆，這裡丟進discardEnergy（見該欄位說明）
        side.discardEnergy.push(side.pendingEnergy);
        // 2026-08-09修正：原本重新隨機roll一個全新的pendingEnergy，完全沒動previewEnergy——
        // 但玩家在這之前就已經看過「下一回合能量」的預覽（previewEnergy不是回合開始才產生，
        // 是已經先算好、只是正常情況要下回合才能用），卡面「the next Energy is produced」指的
        // 就是這份已經存在的預覽直接補上來，不是無關的重新隨機。改用跟回合開始同一套
        // pocketProduceEnergy：pendingEnergy繼承原本的previewEnergy，再重新roll一份新預覽。
        pocketProduceEnergy(side);
      } else {
        return;
      }
      pocketBroadcastState(pRoom);
      return;
    }

    if (type === 'pocket_end_turn') {
      const pRoom = pocketRooms.get(ws.pocketRoomCode);
      if (!pRoom?.G || pRoom.G.phase !== 'active') return;
      const G = pRoom.G; const role = ws.pocketRole;
      if (G.turn !== role) return;
      pocketAdvanceTurn(G);
      pocketBroadcastState(pRoom);
      return;
    }

    // 防呆：任何其他pocket_*訊息先安全忽略，避免掉進下面既有PvP的
    // rooms.get(ws.roomCode) 分支（那是完全不同的Map）。
    if (typeof type === 'string' && type.startsWith('pocket_')) return;

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
      if (card.cat === 'stadium' && spaceCutBlocksSrv(G, role)) {
        send(ws, { type: 'error', message: '對手的空間切割發動中，無法發動競技場卡！' }); return;
      }
      if (HAND_MANIPULATION_CARDS.includes(card.id) && G[`${role}HandCardUsed`] && G.activeStadium?.id !== 'stadium-bug-hive') {
        send(ws, { type: 'error', message: '這回合已經用過抽牌／搶牌類的卡了！' }); return;
      }
      // 2026-07-29新增：少數道具卡額外需要消耗戰鬥能量才能使用（card.energyCost），目前只有夜襲
      if (card.energyCost && (G[`${role}Energy`] || 0) < card.energyCost) {
        send(ws, { type: 'error', message: `能量不足，無法使用【${card.name}】（需要 ${card.energyCost} 點能量）！` }); return;
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
        mine.status2 = null;
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
        G[`${op}StandbyGuard`] = false;
        triggerOnEnterSrv(target, op, G, log, false, true); // 不觸發上場特性／進場陷阱（第6個參數才是真的擋特性）

        const mult = srvEffActive(attacker.type, target.type, target.type2, G);
        const dmg = Math.max(1, Math.round(40 * mult));
        target.cur = Math.max(0, target.cur - dmg);
        log.push({ text: `${target.name} 受到了獵捕的 ${dmg} 點傷害！`, cls: 'special' });
        tryHealingRainbowRevive(target, log);

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
      // 2026-08-14新增：複製（trace）改成「獲得對手上回合使用過的道具卡」，需要記錄每一側
      // 最近一次打出的道具卡——跟pokemon_battle.html的useTrainer()/cpuUseTrainers()同步
      if (card.cat === 'item') G[`${role}LastItemPlayed`] = { ...card };
      // 時間咆哮（time-roar，2026-08-14新增）：累積「這回合打出過的所有道具卡」，給帝牙盧卡
      // 「獲得對手上回合所有道具卡」用，跟LastItemPlayed的單張不同
      if (card.cat === 'item') (G[`${role}ItemsPlayedThisTurn`] = G[`${role}ItemsPlayedThisTurn`] || []).push({ ...card });
      if (card.energyCost) G[`${role}Energy`] -= card.energyCost;

      // 搏命：雙方場上寶可夢同歸於盡——除非對方（op）持有盧恩啟示的搏命免疫（G[op+'RuneShield']），
      // 此時只有發動搏命的role自己倒下，op完全不受影響。2026-08-01：免疫只在授予的那個回合或下一
      // 回合內有效（G.round - G[op+'RuneShieldRound'] <= 1），超過就視同過期，不再擋搏命
      if (card.id === 'sacrifice') {
        const active     = G[`${role}Deck`][G[`${role}Idx`]];
        const opActive   = G[`${op}Deck`][G[`${op}Idx`]];
        const opShielded = !!G[`${op}RuneShield`] && (G.round - (G[`${op}RuneShieldRound`] ?? -Infinity) <= 1);
        let log;
        if (opShielded) {
          G[`${op}RuneShield`] = false;
          active.cur = 0;
          log = [{ text: `對方的【盧恩啟示】發動，只有 ${active.name} 倒下了！`, cls: 'special' }];
        } else {
          active.cur = 0; opActive.cur = 0;
          log = [{ text: `使用了搏命！雙方場上的寶可夢同歸於盡了！`, cls: 'special' }];
        }
        tryHealingRainbowRevive(active, log);
        tryHealingRainbowRevive(opActive, log);
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
        if (!opShielded) G.pendingKOSwitchQueue = [op]; // 被護盾擋下時op沒有倒下，不需要排隊補位
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
      { const op = role === 'p1' ? 'p2' : 'p1'; const oppActive = G[`${op}Deck`][G[`${op}Idx`]];
        if (oppActive?.ability?.id === 'dark-abyss-lockdown') { send(ws, { type: 'error', message: '對方的深淵支配特性封鎖了 Mega 進化！' }); return; } }
      attacker.id = attacker.mega.spriteId;
      attacker.type = attacker.mega.type;
      attacker.type2 = attacker.mega.type2 ?? null;
      attacker.ability = { ...attacker.mega.ability };
      attacker.megaEvolved = true;
      attacker.hp = Math.round(attacker.hp * 1.2); // Mega 進化額外提升 HP 上限（比照真實種族值總和提升）
      attacker.cur = attacker.hp; // Mega 進化時補滿血
      attacker.status = null; // 並解除異常狀態
      attacker.status2 = null;
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
      const atkCost = effectiveCostSrv(atk, defender, G, aBuff, attacker, op, role);
      if ((G[`${role}Energy`] || 0) < atkCost) { send(ws, { type:'error', message:'能量不足，無法使用這個招式' }); return; }

      const log = [];
      const sResult = handleStatus(attacker, log, atk.type, G);

      if (sResult.died) {
        // Attacker KO'd by own status (confusion self-hit — poison/burn no longer resolve here).
        // Attempting to attack (even one that backfired) still consumes the turn, same as the
        // reflect-death case below — previously G.turn was left unchanged here too, letting the
        // same role act again immediately after picking a replacement (same bug class as the
        // reflect fix just below, see project memory for the 2026-07-02 note this was a known,
        // deliberately-unaddressed quirk at the time).
        tryHealingRainbowRevive(attacker, log);
        const alive = G[`${role}Deck`].filter(p => p.cur > 0).length;
        if (alive === 0) {
          endGame(room, op, log); return;
        }
        G.pendingKOSwitch = role;
        G.turn = op;
        G.round++;
        G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; G[`${op}Buff`].debuffReflect = false; G[`${op}StandbyGuard`] = false; // all expire if this role never actually attacked
        G[`${role}Buff`].ignoreReflectNext = false; // 盧恩啟示：無視反彈鏡buff沒打出去就失效（搏命免疫改成回合戳記到期制，見rune-revelation case）
        // op's own poison/burn also ticks here (Pokémon Checkup checks both actives at every
        // turn-end, not just role's) — role already needs a KO switch (pendingKOSwitch=role
        // above), so if op's tick also KOs them, queue op behind role instead of drawing for
        // op immediately; the ko_switch chain draws once both sides have replaced.
        if (tickOpponentStatusAtTurnEndSrv(G, log, op)) {
          const opAlive = G[`${op}Deck`].filter(p => p.cur > 0).length;
          if (opAlive === 0) { endGame(room, role, log); return; }
          G.pendingKOSwitchQueue = [op];
        } else {
          drawForRole(G, op);
        }
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      if (sResult.skipped) {
        // Attack was blocked (sleep/paralysis/freeze) — still apply the attacker's own
        // end-of-turn poison/burn tick before handing the turn to the opponent.
        applyEndOfTurnStatusSrv(attacker, log, G, role);
        tryHealingRainbowRevive(attacker, log);
        if (attacker.cur <= 0) {
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
        G[`${op}SwitchGuard`] = false; // guard only lasts one enemy turn, even if that turn was skipped
        G[`${op}StandbyGuard`] = false; // 格擋同樣只保護一個對方回合，即使那回合被跳過
        G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; G[`${op}Buff`].debuffReflect = false; // all expire if opponent never attacked (status skip)
        G[`${role}Buff`].ignoreReflectNext = false; // 盧恩啟示：無視反彈鏡buff沒打出去就失效（搏命免疫改成回合戳記到期制，見rune-revelation case）
        // op's own poison/burn also ticks here (Pokémon Checkup checks both actives at every
        // turn-end, not just role's).
        if (tickOpponentStatusAtTurnEndSrv(G, log, op)) {
          const opAlive = G[`${op}Deck`].filter(p => p.cur > 0).length;
          if (opAlive === 0) { endGame(room, role, log); return; }
          G.pendingKOSwitch = op;
          G.turn = op;
          broadcast(room, { type: 'update', state: G, log, actor: role }); return;
        }
        G.turn = op;
        drawForRole(G, op);
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      resolveAttackExchangeSrv(room, G, role, op, attacker, defender, atk, atkCost, aBuff, dBuff, log);
      return;
    }

    // Standby (skip attack, draw 1 supporter card)
    if (type === 'standby') {
      if (G.turn !== role || G.pendingKOSwitch) return;
      if (G[`${role}NeedsDiscard`]) return;
      const active = G[`${role}Deck`][G[`${role}Idx`]];
      const log = [];
      tickNonAttackStatusSrv(active, log); // sleep/freeze/confusion still count down even when standing by
      applyEndOfTurnStatusSrv(active, log, G, role); // poison/burn still ticks even when standing by
      const card = pickSupporterAvoidingDupes(G[`${role}Hand`]);
      G[`${role}Hand`].push(card);
      G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;
      // 2026-07-23應使用者要求：待機額外獲得5點Mega能量，提升待機的強度
      if (!G[`${role}MegaUsed`]) G[`${role}MegaEnergy`] = Math.min(20, (G[`${role}MegaEnergy`] || 0) + 5);
      // 待機改名格擋，新增被動：下一次受到的攻擊傷害×0.6，跟switchGuard同一套一次性旗標寫法
      G[`${role}StandbyGuard`] = true;
      log.push({ text: `選擇格擋，${role === 'p1' ? 'P1' : 'P2'} 抽到【${card.name}】，並獲得了 5 點 Mega 能量！下次受到的攻擊傷害將 ×0.6！`, cls: 'system' });

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
      G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; G[`${op}Buff`].debuffReflect = false; G[`${op}StandbyGuard`] = false; // all expire when opponent skips attack
      G[`${role}Buff`].typeOverride = null; // orb effect expires — turn ends without attacking
      G[`${role}Buff`].ignoreReflectNext = false; // 盧恩啟示：無視反彈鏡buff沒打出去就失效（搏命免疫改成回合戳記到期制，見rune-revelation case）
      // op's own poison/burn also ticks here (Pokémon Checkup checks both actives at every
      // turn-end, not just role's).
      if (tickOpponentStatusAtTurnEndSrv(G, log, op)) {
        const opAlive = G[`${op}Deck`].filter(p => p.cur > 0).length;
        if (opAlive === 0) { endGame(room, role, log); return; }
        G.pendingKOSwitch = op;
        G.turn = op;
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }
      G.turn = op;
      G.round++;
      drawForRole(G, op);
      broadcast(room, { type: 'update', state: G, log, actor: role }); return;
    }

    // Switch (ends the turn, unless 撤退背心 granted a free switch); switched-in Pokémon takes ×0.9 damage this turn; switched-out Pokémon heals 100 HP
    if (type === 'switch') {
      if (G.turn !== role || G.pendingKOSwitch) return;
      if (G[`${role}NeedsDiscard`]) return;
      if (G[`${role}SwitchedThisTurn`]) return; // only one switch per turn, free or not
      // 牽制（arena-trap，2026-08-14新增）：對手持有時，這一側不能換人上場
      const opActiveForTrap = G[`${op}Deck`]?.[G[`${op}Idx`]];
      if (!isAbilitySealedSrv(op, G) && opActiveForTrap?.cur > 0 && opActiveForTrap?.ability?.id === 'arena-trap') {
        send(ws, { type: 'error', message: '對手的牽制發動中，無法換人上場！' }); return;
      }
      // 潮漩（tide-vortex，2026-08-15新增）：對手不能交換寶可夢——跟牽制同一套換人封鎖寫法
      if (!isAbilitySealedSrv(op, G) && opActiveForTrap?.cur > 0 && opActiveForTrap?.ability?.id === 'tide-vortex') {
        send(ws, { type: 'error', message: '對手的潮漩發動中，無法換人上場！' }); return;
      }
      const deck   = G[`${role}Deck`];
      const curIdx = G[`${role}Idx`];
      const newIdx = msg.deckIdx;
      if (newIdx === curIdx || !deck[newIdx] || deck[newIdx].cur <= 0) return;

      const usedFreeSwitch = G[`${role}FreeSwitch`]; // 撤退背心：免費換場，不結束回合
      // 疾風之翼：2026-08-13新增，若備戰區（換人前，不含目前主戰）有飛行屬性寶可夢，撤退同樣
      // 不會結束回合——但卡面明講「不能抽支援者卡」，跟撤退背心的usedFreeSwitch分開判斷
      const benchHasFlying = deck.some((p, i) => i !== curIdx && p.cur > 0 && (p.type === 'flying' || p.type2 === 'flying'));
      const usedFlyingWindFree = !usedFreeSwitch && G.activeStadium?.id === 'stadium-flying-wind' && benchHasFlying;
      // 再生力（regenerator，2026-08-15新增）：可以不用結束回合撤退——跟撤退背心/疾風之翼同一套
      // 「換人不消耗回合」判斷，差別是特性驅動、看的是換下場的那隻本身
      const usedRegeneratorFree = !usedFreeSwitch && !usedFlyingWindFree && !isAbilitySealedSrv(role, G) && deck[curIdx]?.ability?.id === 'regenerator';
      const outPoke = deck[curIdx];
      // 2026-08-08修正：混亂可能落在status或status2任一格，原本只清status
      if (outPoke.status?.type === 'confusion') outPoke.status = null;
      if (outPoke.status2?.type === 'confusion') outPoke.status2 = null;
      // 換人時被換下場的寶可夢回復100HP（上限為自身max hp），跟isHealSealedSrv既有的
      // 「所有回血來源都要檢查詛咒」規則一致——要在outPoke還沒被換走前算好
      const outHeal = (outPoke.cur > 0 && !isHealSealedSrv(role, G)) ? Math.min(100, outPoke.hp - outPoke.cur) : 0;
      if (outHeal > 0) outPoke.cur += outHeal;
      const outHealMsg = outHeal > 0 ? `${outPoke.name} 換下場前回復了 ${outHeal} HP！` : null;
      G[`${role}Idx`] = newIdx;
      G[`${role}Buff`] = freshBuff(); G[`${role}Braced`] = false; G[`${role}CoinShield`] = false; G[`${role}StandbyGuard`] = false; // 換人時整組攻擊buff（含屬性寶珠override）都不該留給新上場的寶可夢
      G[`${role}SwitchGuard`] = true; // this turn's incoming damage ×0.9
      G[`${role}FreeSwitch`] = false;
      G[`${role}SwitchedThisTurn`] = true;

      // 2026-07-23應使用者要求：換寶可夢也能抽到1張支援者卡，提升換人的強度——2026-08-13新增
      // 例外：疾風之翼給的免費換場明講不能抽支援者卡
      const drawnCard = usedFlyingWindFree ? null : pickSupporterAvoidingDupes(G[`${role}Hand`]);
      if (drawnCard) G[`${role}Hand`].push(drawnCard);
      G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;
      const drawSuffix = drawnCard ? `抽到了【${drawnCard.name}】！` : '';

      if (usedFreeSwitch || usedFlyingWindFree || usedRegeneratorFree) {
        const sourceLabel = usedFreeSwitch ? '撤退背心' : usedFlyingWindFree ? '疾風之翼' : '再生力';
        const log = [{ text: `換上了 ${deck[newIdx].name}！（${sourceLabel}：不消耗回合）本回合傷害減免中…${drawSuffix}`, cls: 'player' }];
        if (outHealMsg) log.push({ text: outHealMsg, cls: 'special' });
        triggerOnLeaveSrv(outPoke, role, G, log);
        triggerOnEnterSrv(deck[newIdx], role, G, log);
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      G[`${role}SuppUsed`] = false;
      G[`${role}HandCardUsed`] = false;
      G[`${role}SwitchedThisTurn`] = false; // this turn is over — clear it so role can switch again on their *next* turn
      G.turn = op;
      G.round++;
      G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; G[`${op}Buff`].debuffReflect = false; G[`${op}StandbyGuard`] = false; // all expire if opponent never attacked (switched instead)
      drawForRole(G, op);
      const log = [{ text: `換上了 ${deck[newIdx].name}！本回合傷害減免中…${drawSuffix}`, cls: 'player' }];
      if (outHealMsg) log.push({ text: outHealMsg, cls: 'special' });
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
      G[`${role}Buff`] = freshBuff(); G[`${role}Braced`] = false; G[`${role}CoinShield`] = false; G[`${role}StandbyGuard`] = false; // 倒下的寶可夢離場，累積的攻擊buff不該留給替補上場的寶可夢
      G[`${role}Idx`] = newIdx;
      G.pendingKOSwitch = null;
      triggerOnEnterSrv(deck[newIdx], role, G, log);

      // 羅馬鬥技場：如果這次替補是因為鬥屬性攻擊的「第一下」打倒的，這裡要在正式交還回合之前，
      // 先補上被記錄下來的「第二下」（傷害減半），目標換成新上場的這隻寶可夢
      const pendingHit = G[`${role}PendingColosseumHit`];
      if (pendingHit) {
        delete G[`${role}PendingColosseumHit`];
        const atkrRole = pendingHit.attackerRole;
        const atkr = G[`${atkrRole}Deck`][G[`${atkrRole}Idx`]];
        const newDefender = deck[newIdx];
        if (atkr.cur > 0 && newDefender.cur > 0) {
          doAttack(atkr, newDefender, pendingHit.atk, G[`${atkrRole}Buff`], G[`${role}Buff`], log, G, 1, 1);
          tryHealingRainbowRevive(newDefender, log);
          if (newDefender.cur <= 0) {
            const alive = deck.filter(p => p.cur > 0).length;
            if (alive === 0) {
              endGame(room, atkrRole, log); return;
            }
            G.pendingKOSwitch = role;
            broadcast(room, { type: 'update', state: G, log, actor: role }); return;
          }
        }
      }

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
      // 2026-07-23應使用者要求：棄1張換競技場卡每回合上限3次——驗證放在真的splice手牌之前，
      // 免得被拒絕的請求還是白白扣了牌
      if (cardType === 'stadium' && (G[`${role}StadiumTradeCount`] || 0) >= 3) {
        send(ws, { type: 'error', message: '這回合已經換過3次競技場卡了！' }); return;
      }
      const sorted = [...indices].sort((a,b) => b-a);
      sorted.forEach(i => hand.splice(i, 1));
      if (cardType === 'stadium') G[`${role}StadiumTradeCount`] = (G[`${role}StadiumTradeCount`] || 0) + 1;
      if (cardType === 'energy') {
        const gain = Math.min(20 - G[`${role}Energy`], 5);
        G[`${role}Energy`] = Math.min(20, G[`${role}Energy`] + 5);
        G[`${role}NeedsDiscard`] = hand.length > 7;
        const log = [{ text: `棄牌換能量！回復了 ${gain} 點能量！（現在 ${G[`${role}Energy`]}/20）`, cls: 'system' }];
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }
      if (cardType === 'cure') {
        const active = G[`${role}Deck`][G[`${role}Idx`]];
        const slot1Blocked = active.status && isStatusCureBlockedSrv(G, active.status.type);
        const slot2Blocked = active.status2 && isStatusCureBlockedSrv(G, active.status2.type);
        let log;
        if (!active.status && !active.status2) {
          log = [{ text: `${active.name}目前沒有異常狀態。`, cls: 'system' }];
        } else {
          const cured = [];
          if (active.status && !slot1Blocked) { cured.push(STATUS_ZH[active.status.type] || active.status.type); active.status = null; }
          if (active.status2 && !slot2Blocked) { cured.push(STATUS_ZH[active.status2.type] || active.status2.type); active.status2 = null; }
          if (cured.length) {
            log = [{ text: `棄牌解除了${active.name}的${cured.join('、')}！${(slot1Blocked || slot2Blocked) ? '（部分異常狀態被場地效果封印，無法解除）' : ''}`, cls: 'system' }];
          } else {
            log = [{ text: `異常狀態被場地效果封印，無法解除！`, cls: 'system' }];
          }
        }
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }
      // 2026-07-23應使用者要求修復：原本沒有依場上寶可夢屬性過濾
      const activeForTrade = G[`${role}Deck`][G[`${role}Idx`]];
      const pool = TRAINERS.filter(c => c.cat === cardType &&
        (!c.type || c.type === activeForTrade.type || c.type === activeForTrade.type2));
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
    await pool.query(`ALTER TABLE pet_decorations ADD COLUMN IF NOT EXISTS scale REAL NOT NULL DEFAULT 1`);
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
    // 彈弓小遊戲的鳥類收藏——跟pet_fish/pet_fish_discovered同一套設計（SERIAL PK允許重複擁有
    // 同一種、discovered表跟目前擁有量分開避免圖鑑因為之後可能的賣出/放生機制而倒退）。
    // 必須排在下面ALTER TABLE pets之前，因為display_bird_id的外鍵參照到這張表。
    await pool.query(`CREATE TABLE IF NOT EXISTS pet_birds (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bird_type TEXT NOT NULL,
      caught_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS pet_birds_discovered (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      bird_type TEXT NOT NULL,
      discovered_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, bird_type)
    )`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS display_bird_id INTEGER REFERENCES pet_birds(id) ON DELETE SET NULL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS birdcage_pos_x REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS birdcage_pos_y REAL`);
    // 鳥籠設定比照魚缸（2026-07-26應使用者要求）：「我的最愛」標記，sell()/sell-duplicates()會拒賣/跳過
    await pool.query(`ALTER TABLE pet_birds ADD COLUMN IF NOT EXISTS is_favorite BOOLEAN NOT NULL DEFAULT FALSE`);
    // 寶可夢展示台——3個獨立展示位，取代「我的收藏」側欄。display_poke{n}_id只存POKEMON靜態
    // 陣列的id（跟teams.pokemon_ids本身的存法一致），不是外鍵；隊伍是陣列欄位沒有資料表列可以
    // 外鍵約束，展示中的寶可夢被放生時改成在resolve-release端點手動UPDATE清空（見該端點）。
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS display_poke1_id INTEGER`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS display_poke2_id INTEGER`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS display_poke3_id INTEGER`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display1_pos_x REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display1_pos_y REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display2_pos_x REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display2_pos_y REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display3_pos_x REAL`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display3_pos_y REAL`);
    // 展示台每個展示位可以獨立決定要不要水平翻轉（純視覺偏好，不影響任何數值）
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display1_flip BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display2_flip BOOLEAN NOT NULL DEFAULT false`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS poke_display3_flip BOOLEAN NOT NULL DEFAULT false`);
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
    // 房間裝飾從「每種最多擁有一份」改成可以買多份、同時擺多個——(user_id,item_id)複合主鍵
    // 沒辦法表達同一種裝飾的多份實體，改成跟pet_fish一樣的SERIAL id單獨當PK。這個PK swap本身
    // 不是「加欄位」那種天生可重複執行的操作（ADD PRIMARY KEY 在已經有PK的表上重跑會直接報錯），
    // 所以放進runMigrationOnce裡只跑一次，不是跟其他ALTER COLUMN IF NOT EXISTS放在一起。
    await runMigrationOnce('2026-07-23-decor-multi-instance-pk', async () => {
      await pool.query(`ALTER TABLE pet_decorations ADD COLUMN IF NOT EXISTS id SERIAL`);
      await pool.query(`ALTER TABLE pet_decorations DROP CONSTRAINT IF EXISTS pet_decorations_pkey`);
      await pool.query(`ALTER TABLE pet_decorations ADD PRIMARY KEY (id)`);
    });
    // Pocket TCG 抽卡包收藏系統（2026-08-05新增）：卡片擁有量用(user_id,card_id)複合PK+count
    // 累加（不是SERIAL多列，因為同一張卡擁有幾張只在乎數量，不需要個別追蹤是哪次開包抽到的）。
    await pool.query(`CREATE TABLE IF NOT EXISTS pocket_collection (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, card_id)
    )`);
    // 已存牌組——最多20副（server端在新增時檢查數量上限，不是靠資料庫層級約束），card_ids是
    // 20張卡id的陣列（可重複，同一張卡最多2張的規則在存檔時驗證，不是資料庫約束）
    await pool.query(`CREATE TABLE IF NOT EXISTS pocket_decks (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '未命名牌組',
      card_ids TEXT[] NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
    // 牌組手動自選能量種類（見pocketValidateEnergyTypes）——NULL代表沒有自訂，戰鬥開始時
    // 退回pocketDeckEnergyTypes自動偵測，不是每副舊牌組都要補值
    await pool.query(`ALTER TABLE pocket_decks ADD COLUMN IF NOT EXISTS energy_types TEXT[]`);
    // 每日5包免費開包額度——跟claim-daily-coins同一套「用DATE欄位lazy重置，交給Postgres
    // CURRENT_DATE比對，不要把DATE讀回JS再轉字串比較」的手法（那邊的註解記錄了時區bug教訓）
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS pocket_free_packs_date DATE`);
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS pocket_free_packs_used INTEGER NOT NULL DEFAULT 0`);
    // 保底計數（見pocketRollPackWithPity）：連續開幾包沒抽到2星以上，滿100強制觸發保底
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS pocket_pity_counter INTEGER NOT NULL DEFAULT 0`);
    // 卡牌晶鑽（見POCKET_DISMANTLE_SHARDS/POCKET_SYNTHESIZE_COST）：分解卡片獲得、合成卡片消耗
    await pool.query(`ALTER TABLE pets ADD COLUMN IF NOT EXISTS pocket_shards INTEGER NOT NULL DEFAULT 0`);
    // 第二隻寵物（2026-08-10新增，見pet-tamagotchi skill）：花5000金幣買下的第二隻寵物先進「備用」，
    // 不會取代目前顯示的那隻——玩家用左側切換鈕才會真的把pets表跟這張表的內容互換。只存「每隻
    // 寵物各自的身分/照顧狀態」欄位（物種/好感度/飢餓值/上次餵食+互動時間），不存coins/裝飾/球數/
    // Pocket TCG相關欄位——那些是帳號共用的錢包/收藏，不是單一寵物的專屬狀態，切換時不動它們。
    // user_id當PK天然限制「最多只能備用1隻」，符合這次「先開放只能多買一隻」的範圍。
    await pool.query(`CREATE TABLE IF NOT EXISTS pet_bench (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      species_id INTEGER NOT NULL,
      happiness INTEGER NOT NULL DEFAULT 50,
      hunger INTEGER NOT NULL DEFAULT 100,
      last_fed_at TIMESTAMPTZ DEFAULT NOW(),
      last_interaction_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
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
