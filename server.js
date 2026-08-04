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
  // Tier 1
  { mega:{spriteId:10033, type:'grass', type2:'poison', ability:{id:'thick-fat', name:'厚脂肪', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}}, id:3,   name:'妙蛙花',     type:'grass',    type2:'poison',  hp:250, tier:1, ability:{id:'blaze-boost', name:'茂盛', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'逆鱗吸能擊',dmg:46,cost:1,type:'dragon',rider:'energy-steal'},{name:'大地之力',dmg:65,cost:6,type:'ground',status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'藤鞭',dmg:72,cost:6,type:'grass',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'惡意突刺',dmg:91,cost:11,type:'poison',ignoreReflect:true,status:{effect:'burn', chance:0.4},bonusVsType:'electric',ignoreShield:true}]},
  { mega:{spriteId:10038, type:'ghost', type2:'poison', ability:{id:'frisk-ward', name:'踩影', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:94,  name:'耿鬼',       type:'ghost',    type2:'poison',  hp:220, tier:1, ability:{id:'poison-heal', name:'毒療', trigger:'onStatus', desc:'中毒時每回合回復 1/8 最大HP，而非扣血'}, attacks:[{name:'催眠術',dmg:50,cost:3,type:'psychic',rider:'mega-charge',status:{effect:'sleep', chance:0.5},megaBoost:true,bonusEnergy:6,status2:{effect:'confusion',chance:0.5}},{name:'幽靈之爪',dmg:80,cost:8,type:'ghost',rider:'type-draw',status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'confusion',chance:0.4}},{name:'污泥炸彈',dmg:100,cost:13,type:'poison',megaBoost:true,bonusEnergy:7},{name:'妖精護甲擊',dmg:49,cost:3,type:'fairy',rider:'self-cure'}]},
  { id:68,  name:'怪力',       type:'fighting', hp:260, tier:1, ability:{id:'fighting-domain', name:'鬥氣支配', trigger:'onEnter', desc:'上場時場地切換為羅馬鬥技場；格鬥屬性攻擊傷害額外 +40'}, attacks:[{name:'幽靈之爪',dmg:48,cost:2,type:'ghost',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'岩石滑落',dmg:68,cost:7,type:'rock',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'疾風強奪擊',dmg:75,cost:7,type:'flying',ignoreReflect:true,rider:'card-steal'},{name:'動感拳',dmg:94,cost:12,type:'fighting',selfHeal:0.21,bonusVsType:'psychic',ignoreReflect:true}]},
  { mega:{spriteId:10037, type:'psychic', type2:null, ability:{id:'trace', name:'複製', trigger:'onEnter', desc:'上場時複製對手當前的特性'}}, id:65,  name:'胡地',       type:'psychic',  hp:200, tier:1, ability:{id:'sync-status', name:'同步', trigger:'onDefend', desc:'陷入中毒／麻痺／燒傷時，會將該狀態傳染給攻擊者'}, attacks:[{name:'暗影球',dmg:44,cost:0,type:'ghost',rider:'self-cure',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'poison',chance:0.4}},{name:'寶石爆破',dmg:40,cost:0,type:'rock',ignoreReflect:true,status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:4,status2:{effect:'poison',chance:0.4}},{name:'超能力',dmg:87,cost:11,type:'psychic',megaBoost:true,bonusEnergy:4},{name:'冰霜吸血擊',dmg:71,cost:6,type:'ice',rider:'type-draw'}]},
  { mega:{spriteId:10304, type:'electric', type2:null, ability:{id:'motor-drive', name:'電氣場地', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:26,  name:'雷丘',       type:'electric', hp:200, tier:1, ability:{id:'static', name:'靜電', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入麻痺'}, attacks:[{name:'橫衝直撞',dmg:43,cost:0,type:'normal',rider:'type-draw',megaBoost:true,bonusEnergy:4},{name:'石刃',dmg:40,cost:0,type:'rock',rider:'energy-steal',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'burn',chance:0.4}},{name:'十萬伏特',dmg:86,cost:11,type:'electric',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:4,bonusVsType:'bug'},{name:'逆鱗威壓擊',dmg:70,cost:6,type:'dragon',rider:'mega-charge'}]},
  { mega:{spriteId:10076, type:'steel', type2:'psychic', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:376, name:'巨金怪',     type:'steel',    type2:'psychic', hp:260, tier:1, ability:{id:'solid-rock', name:'硬岩', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'隕石衝擊',dmg:48,cost:2,type:'rock',rider:'type-draw',megaBoost:true,bonusEnergy:6},{name:'冰霜吸能擊',dmg:72,cost:8,type:'ice',rider:'energy-steal'},{name:'念力',dmg:79,cost:8,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'子彈拳',dmg:99,cost:13,type:'steel',ignoreReflect:true,selfHeal:0.25,bonusVsType:'fire',ignoreShield:true}]},
  { mega:{spriteId:10059, type:'fighting', type2:'steel', ability:{id:'adaptability', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:448, name:'路卡利歐',   type:'fighting', type2:'steel',   hp:220, tier:1, ability:{id:'guts', name:'堅韌', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'灼熱護甲擊',dmg:54,cost:3,type:'fire',rider:'energy-steal'},{name:'暗影球',dmg:50,cost:3,type:'ghost',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'龍之脈動',dmg:80,cost:8,type:'dragon',megaBoost:true,bonusEnergy:6},{name:'金屬爪',dmg:100,cost:13,type:'steel',selfHeal:0.18,bonusVsType:'psychic',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10041, type:'water', type2:'dark', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對方的防禦型特性'}}, id:130, name:'暴鯉龍',     type:'water',    type2:'flying',  hp:260, tier:1, ability:{id:'no-weakness-dodge', name:'深淵支配', trigger:'onDefend', desc:'不會受到超效傷害；10% 機率完全閃避攻擊'}, attacks:[{name:'大地強奪擊',dmg:79,cost:8,type:'ground',rider:'card-steal',ignoreReflect:true},{name:'咬碎',dmg:75,cost:8,type:'dark',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'怒風',dmg:54,cost:2,type:'flying',rider:'mega-charge',megaBoost:true,bonusEnergy:6},{name:'水砲',dmg:102,cost:13,type:'water',status:{effect:'sleep', chance:0.4},bonusVsType:'psychic'}]},
  { id:87,  name:'白海獅',     type:'water',    type2:'ice',     hp:240, tier:1, ability:{id:'legacy-boost', name:'指揮', trigger:'onLeave', desc:'陣亡或被換下場時，下一隻上場的我方寶可夢首次攻擊：能量消耗×0.5、傷害+40'}, attacks:[{name:'未來雷霆',dmg:44,cost:0,type:'psychic',ignoreReflect:true,status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'paralysis',chance:0.4}},{name:'荒草吸血擊',dmg:68,cost:6,type:'grass',rider:'mega-charge'},{name:'大浪',dmg:64,cost:6,type:'water',megaBoost:true,bonusEnergy:4,rider:'energy-steal'},{name:'冷凍光線',dmg:94,cost:11,type:'ice',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting'}]},
  { id:82,  name:'三合一磁怪',   type:'electric', type2:'steel',   hp:210, tier:1, ability:{id:'item-synergy', name:'機械之心', trigger:'onAttack', desc:'本回合使用過道具卡時，攻擊傷害 +40'}, attacks:[{name:'衝浪',dmg:54,cost:2,type:'water',ignoreReflect:true,status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'sleep',chance:0.4}},{name:'劇毒威壓擊',dmg:50,cost:2,type:'poison',rider:'mega-charge'},{name:'金屬音',dmg:74,cost:8,type:'steel',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'電磁炮',dmg:105,cost:13,type:'electric',selfHeal:0.18,bonusVsType:'ground',ignoreReflect:true}]},
  { id:28,  name:'穿山王',     type:'ground',   hp:240, tier:1, ability:{id:'ground-domain', name:'風沙支配', trigger:'onEnter', desc:'上場時場地切換為沙塵暴；地面屬性攻擊傷害額外 +40'}, attacks:[{name:'精神吸能擊',dmg:41,cost:1,type:'psychic',rider:'energy-steal'},{name:'水之脈動',dmg:76,cost:7,type:'water',megaBoost:true,bonusEnergy:4,rider:'mega-charge'},{name:'岩石碎裂',dmg:72,cost:7,type:'rock',megaBoost:true,bonusEnergy:4},{name:'地震',dmg:91,cost:12,type:'ground',status:{effect:'sleep', chance:0.4},bonusVsType:'ground',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10071, type:'water', type2:'psychic', ability:{id:'sturdy', name:'硬殼盔甲', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}}, id:80,  name:'呆殼獸',     type:'water',    type2:'psychic', hp:260, tier:1, ability:{id:'own-tempo', name:'我行我素', trigger:'onDefend', desc:'不會陷入混亂狀態'}, attacks:[{name:'連續切',dmg:50,cost:2,type:'bug',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'精神強擊',dmg:70,cost:7,type:'psychic',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:5,rider:'move-reflect'},{name:'灼熱護甲擊',dmg:77,cost:7,type:'fire',rider:'mega-charge'},{name:'衝浪',dmg:96,cost:12,type:'water',ignoreReflect:true,status:{effect:'confusion', chance:0.4},bonusVsType:'psychic'}]},
  { id:823, name:'鋼鎧鴉',     type:'steel',    type2:'flying',  hp:250, tier:1, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'念力衝擊',dmg:51,cost:2,type:'psychic',rider:'energy-steal',megaBoost:true,bonusEnergy:5},{name:'空氣斬',dmg:71,cost:7,type:'flying',megaBoost:true,bonusEnergy:5},{name:'激流強奪擊',dmg:78,cost:7,type:'water',rider:'card-steal'},{name:'鐵翼',dmg:97,cost:12,type:'steel',selfHeal:0.28,bonusVsType:'fighting',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10283, type:'water', type2:'dragon', ability:{id:'adaptability', name:'龍化', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:160, name:'大力鱷',     type:'water',    hp:260, tier:1, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'灼熱吸血擊',dmg:45,cost:2,type:'fire',rider:'self-cure',bonusVsType:'bug'},{name:'冰凍拳',dmg:80,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6,rider:'card-steal'},{name:'電擊',dmg:76,cost:8,type:'electric',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'衝浪',dmg:96,cost:13,type:'water',status:{effect:'paralysis', chance:0.4},bonusVsType:'water'}]},
  { mega:{spriteId:10294, type:'water', type2:'dark', ability:{id:'adaptability', name:'變幻自如', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:658, name:'甲賀忍蛙',       type:'water',    type2:'dark',    hp:220, tier:1, ability:{id:'rough-skin', name:'粗糙皮膚', trigger:'onDefend', desc:'受到攻擊傷害時，反彈攻擊者 1/8 最大HP 傷害'}, attacks:[{name:'影子偷襲',dmg:56,cost:3,type:'ghost',rider:'energy-steal',megaBoost:true,bonusEnergy:6,bonusVsType:'ground'},{name:'夜斬',dmg:80,cost:9,type:'dark',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'水手裏劍',dmg:110,cost:14,type:'water',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'荒草威壓擊',dmg:55,cost:3,type:'grass',rider:'mega-charge'}]},
  // Tier 2
  { mega:{spriteId:10034, type:'fire', type2:'dragon', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:6,   name:'噴火龍',     type:'fire',     type2:'flying',  hp:290, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'雷光強奪擊',dmg:69,cost:7,type:'electric',rider:'type-draw',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'龍爪',dmg:48,cost:1,type:'dragon',rider:'energy-steal',megaBoost:true,bonusEnergy:5},{name:'火焰噴射',dmg:95,cost:12,type:'fire',status:{effect:'paralysis', chance:0.4},bonusVsType:'flying'},{name:'燕返',dmg:91,cost:12,type:'flying',status:{effect:'freeze', chance:0.4},bonusVsType:'bug',ignoreReflect:true}]},
  { mega:{spriteId:10036, type:'water', type2:null, ability:{id:'huge-power', name:'超級發射器', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:9,   name:'水箭龜',     type:'water',    hp:280, tier:2, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'妖精吸血擊',dmg:42,cost:0,type:'fairy',rider:'mega-charge',megaBoost:true,bonusEnergy:4},{name:'蟲毒吸能擊',dmg:66,cost:6,type:'bug',rider:'type-draw'},{name:'水砲',dmg:96,cost:11,type:'water',selfHeal:0.28,bonusVsType:'dark'},{name:'冰凍光束',dmg:92,cost:11,type:'ice',selfHeal:0.29,bonusVsType:'dragon',ignoreReflect:true}]},
  { mega:{spriteId:10043, type:'psychic', type2:'fighting', ability:{id:'guts', name:'不屈之心', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:150, name:'超夢',       type:'psychic',  hp:320, tier:2, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'氣功拳',dmg:89,cost:11,type:'fighting',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:4},{name:'念力衝擊',dmg:96,cost:11,type:'psychic',selfHeal:0.19,bonusVsType:'rock'},{name:'閃電拳',dmg:92,cost:11,type:'electric',status:{effect:'sleep', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'暗影球',dmg:65,cost:6,type:'ghost',rider:'type-draw',status:{effect:'poison', chance:0.4},status2:{effect:'burn',chance:0.4}}]},
  { mega:{spriteId:10281, type:'dragon', type2:'flying', ability:{id:'multiscale', name:'多重鱗片', trigger:'onDefend', desc:'HP 全滿時，受到的攻擊傷害 ×0.9'}}, id:149, name:'快龍',       type:'dragon',   type2:'flying',  hp:320, tier:2, ability:{id:'multiscale', name:'多重鱗片', trigger:'onDefend', desc:'HP 全滿時，受到的攻擊傷害 ×0.9'}, attacks:[{name:'雷電',dmg:87,cost:11,type:'electric',megaBoost:true,bonusEnergy:4},{name:'逆鱗護甲擊',dmg:94,cost:11,type:'dragon',status:{effect:'paralysis', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'冰霜護甲擊',dmg:67,cost:6,type:'ice',rider:'energy-steal'},{name:'破壞光線',dmg:86,cost:11,type:'normal',status:{effect:'paralysis', chance:0.4},ignoreReflect:true,ignoreShield:true}]},
  { id:143, name:'卡比獸',     type:'normal',   hp:380, tier:2, ability:{id:'normal-domain', name:'神域支配', trigger:'onEnter', desc:'上場時場地切換為莊嚴神社；一般屬性攻擊傷害額外 +40'}, attacks:[{name:'磚塊',dmg:105,cost:15,type:'rock',megaBoost:true,bonusEnergy:8},{name:'鐵頭',dmg:89,cost:10,type:'steel',rider:'self-cure',selfHeal:0.25},{name:'地震',dmg:108,cost:15,type:'ground',status:{effect:'freeze', chance:0.4},bonusVsType:'poison'},{name:'喊叫',dmg:110,cost:15,type:'normal',selfHeal:0.29,bonusVsType:'rock',ignoreReflect:true,ignoreShield:true}]},
  { id:59,  name:'風速狗',     type:'fire',     hp:260, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'連續啃咬',dmg:52,cost:2,type:'dark',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'冰霜強奪擊',dmg:76,cost:8,type:'ice',rider:'type-draw'},{name:'頭槌',dmg:72,cost:8,type:'normal',megaBoost:true,bonusEnergy:5},{name:'噴射火焰',dmg:103,cost:13,type:'fire',ignoreReflect:true,status:{effect:'burn', chance:0.4},bonusVsType:'ice',ignoreShield:true}]},
  { id:131, name:'拉普拉斯',   type:'water',    type2:'ice',     hp:290, tier:2, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'遠古之力',dmg:49,cost:1,type:'rock',rider:'type-draw',megaBoost:true,bonusEnergy:5},{name:'冷凍光線',dmg:73,cost:7,type:'ice',rider:'energy-steal',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'雷電',dmg:92,cost:12,type:'electric',selfHeal:0.21,bonusVsType:'water'},{name:'衝浪',dmg:99,cost:12,type:'water',selfHeal:0.17,bonusVsType:'flying',ignoreReflect:true}]},
  { mega:{spriteId:10058, type:'dragon', type2:'ground', ability:{id:'blaze-boost', name:'沙之力', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:445, name:'烈咬陸鯊',   type:'dragon',   type2:'ground',  hp:280, tier:2, ability:{id:'frisk-ward', name:'沙隱', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'惡意突刺',dmg:50,cost:1,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'疾風吸血擊',dmg:74,cost:7,type:'flying',rider:'life-drain'},{name:'地震',dmg:93,cost:12,type:'ground',selfHeal:0.23,bonusVsType:'fire'},{name:'龍爪',dmg:100,cost:12,type:'dragon',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true}]},
  { id:210, name:'布魯皇',     type:'fairy',    hp:300, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'咬碎',dmg:70,cost:7,type:'dark',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'雷電',dmg:53,cost:2,type:'electric',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'poison',chance:0.4}},{name:'妖精之力',dmg:96,cost:12,type:'fairy',status:{effect:'sleep', chance:0.4},bonusVsType:'ghost',ignoreReflect:true},{name:'地震',dmg:92,cost:12,type:'ground',status:{effect:'confusion', chance:0.4},bonusVsType:'steel'}]},
  { id:700, name:'仙子伊布',   type:'fairy',    hp:300, tier:2, ability:{id:'fairy-domain', name:'妖精支配', trigger:'onEnter', desc:'上場時場地切換為妖精結界原野；妖精屬性攻擊傷害額外 +40'}, attacks:[{name:'毒牙',dmg:52,cost:3,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'冰凍光束',dmg:82,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'poison',chance:0.4}},{name:'妖精風',dmg:102,cost:13,type:'fairy',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true},{name:'暗影球',dmg:98,cost:13,type:'ghost',status:{effect:'freeze', chance:0.4},bonusVsType:'psychic'}]},
  { mega:{spriteId:10285, type:'ice', type2:'ghost', ability:{id:'solid-rock', name:'降雪', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:478, name:'雪妖女',     type:'ice',      type2:'ghost',   hp:280, tier:2, ability:{id:'frisk-ward', name:'雪隱', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'怒風',dmg:50,cost:1,type:'flying',rider:'energy-steal',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:4,status2:{effect:'sleep',chance:0.4}},{name:'冰凍光束',dmg:97,cost:12,type:'ice',megaBoost:true,bonusEnergy:4},{name:'幽靈球',dmg:93,cost:12,type:'ghost',ignoreReflect:true,status:{effect:'sleep', chance:0.4},bonusVsType:'ghost'},{name:'激流威壓擊',dmg:77,cost:7,type:'water',rider:'mega-charge'}]},
  { id:614, name:'凍原熊',     type:'ice',      hp:215, tier:2, ability:{id:'ice-domain', name:'冰霜支配', trigger:'onEnter', desc:'上場時場地切換為永凍冰原；冰屬性攻擊傷害額外 +40'}, attacks:[{name:'地震',dmg:51,cost:2,type:'ground',rider:'mega-charge',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'confusion',chance:0.4}},{name:'大浪',dmg:75,cost:8,type:'water',status:{effect:'poison', chance:0.4},bonusVsType:'rock',ignoreReflect:true},{name:'火焰噴射',dmg:54,cost:2,type:'fire',status:{effect:'burn', chance:0.4}},{name:'冰耳光',dmg:102,cost:13,type:'ice',status:{effect:'poison', chance:0.4},bonusVsType:'poison'}]},
  { id:430, name:'烏鴉頭頭',     type:'dark',     type2:'flying',  hp:300, tier:2, ability:{id:'insomnia', name:'不眠', trigger:'onDefend', desc:'不會陷入睡眠狀態'}, attacks:[{name:'超能力',dmg:51,cost:3,type:'psychic',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'暴風',dmg:86,cost:9,type:'flying',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'夜斬',dmg:105,cost:14,type:'dark',selfHeal:0.22,bonusVsType:'fighting',ignoreReflect:true},{name:'毒粉刺',dmg:101,cost:14,type:'poison',status:{effect:'poison', chance:0.4},bonusVsType:'grass'}]},
  { id:466, name:'電擊魔獸',   type:'electric', hp:300, tier:2, ability:{id:'electric-domain', name:'雷霆支配', trigger:'onEnter', desc:'上場時場地切換為雷雲庇護所；電屬性攻擊傷害額外 +40'}, attacks:[{name:'冰凍拳',dmg:85,cost:9,type:'ice',rider:'type-draw',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'決勝衝擊',dmg:53,cost:3,type:'fighting',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'超能力',dmg:100,cost:14,type:'psychic',selfHeal:0.18,bonusVsType:'fighting'},{name:'電磁衝浪',dmg:107,cost:14,type:'electric',status:{effect:'poison', chance:0.4},bonusVsType:'ground',ignoreReflect:true}]},
  { id:467, name:'鴨嘴炎獸',   type:'fire',     hp:300, tier:2, ability:{id:'flame-body', name:'火焰之軀', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入燒傷'}, attacks:[{name:'惡意突刺',dmg:82,cost:8,type:'poison',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'sleep',chance:0.4}},{name:'地震',dmg:55,cost:3,type:'ground',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'閃電拳',dmg:98,cost:13,type:'electric',status:{effect:'paralysis', chance:0.4},bonusVsType:'water',ignoreReflect:true},{name:'火焰衝擊',dmg:105,cost:13,type:'fire',status:{effect:'poison', chance:0.4},bonusVsType:'fairy'}]},
  { id:157, name:'火爆獸',     type:'fire',                      hp:260, tier:2, ability:{id:'drought-lava', name:'熔岩大地', trigger:'onEnter', desc:'上場時場地切換為熔岩火山；地面／火屬性攻擊傷害額外 +40'}, attacks:[{name:'疾風吸能擊',dmg:78,cost:8,type:'flying',ignoreReflect:true,rider:'energy-steal'},{name:'地震',dmg:74,cost:8,type:'ground',megaBoost:true,bonusEnergy:7,rider:'self-cure'},{name:'毒粉刺',dmg:58,cost:3,type:'poison',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'爆炸火焰',dmg:101,cost:13,type:'fire',status:{effect:'poison', chance:0.4},bonusVsType:'fairy'}]},
  { mega:{spriteId:10282, type:'grass', type2:'fairy', ability:{id:'huge-power', name:'太陽核心', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:154, name:'大竺葵',     type:'grass',                     hp:270, tier:2, ability:{id:'blaze-boost', name:'茂盛', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'逆鱗護甲擊',dmg:58,cost:5,type:'dragon',rider:'mega-charge',bonusVsType:'dragon'},{name:'大地之力',dmg:89,cost:10,type:'ground',megaBoost:true,bonusEnergy:8,rider:'mega-charge'},{name:'閃電拳',dmg:85,cost:10,type:'electric',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'花瓣風暴',dmg:110,cost:15,type:'grass',status:{effect:'paralysis', chance:0.4},bonusVsType:'water'}]},
  // Tier 3
  { id:383, name:'固拉多',     type:'ground',   hp:300, tier:3, ability:{id:'drought-lava', name:'熔岩大地', trigger:'onEnter', desc:'上場時場地切換為熔岩火山；地面／火屬性攻擊傷害額外 +40'}, attacks:[{name:'地震',dmg:103,cost:13,type:'ground',megaBoost:true,bonusEnergy:6,bonusVsType:'fire',ignoreReflect:true},{name:'岩石碎裂',dmg:52,cost:3,type:'rock',selfHeal:0.22},{name:'火焰噴射',dmg:82,cost:8,type:'fire',ignoreReflect:true,status:{effect:'confusion', chance:0.4},status2:{effect:'sleep',chance:0.4}},{name:'妖精威壓擊',dmg:102,cost:13,type:'fairy',rider:'move-reflect',status:{effect:'burn', chance:0.4},selfHeal:0.26}]},
  { id:382, name:'蓋歐卡',     type:'water',    hp:290, tier:3, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'橫衝直撞',dmg:77,cost:8,type:'normal',rider:'energy-steal',megaBoost:true,bonusEnergy:5,ignoreReflect:true},{name:'雷電',dmg:97,cost:13,type:'electric',status:{effect:'burn', chance:0.4},bonusVsType:'water'},{name:'源起之波',dmg:104,cost:13,type:'water',selfHeal:0.16,ignoreReflect:true},{name:'原始海洋',dmg:48,cost:2,type:'ice',rider:'type-draw',selfHeal:0.21}]},
  { mega:{spriteId:10079, type:'dragon', type2:'flying', ability:{id:'solid-rock', name:'德爾塔氣流', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:384, name:'烈空坐',     type:'dragon',   type2:'flying',  hp:320, tier:3, ability:{id:'weaken-buffs', name:'威壓氣場', trigger:'onDefend', desc:'對手的攻擊力提升效果減半'}, attacks:[{name:'燕返',dmg:95,cost:11,type:'flying',rider:'self-cure',megaBoost:true,bonusEnergy:7},{name:'火焰噴射',dmg:91,cost:11,type:'fire',status:{effect:'freeze', chance:0.4},bonusVsType:'steel'},{name:'神速',dmg:87,cost:11,type:'normal',status:{effect:'poison', chance:0.4},bonusVsType:'bug'},{name:'龍之隕星',dmg:71,cost:6,type:'dragon',rider:'self-cure',status:{effect:'burn', chance:0.4},status2:{effect:'confusion',chance:0.4}}]},
  { id:1008,name:'密勒頓',     type:'electric', type2:'dragon',  hp:360, tier:3, ability:{id:'hadron-engine', name:'強子引擎', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1；每回合開始必定額外抽到一張電光石火'}, attacks:[{name:'電磁衝浪',dmg:99,cost:13,type:'electric',ignoreReflect:true,status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:7,bonusVsType:'flying'},{name:'逆鱗護甲擊',dmg:106,cost:13,type:'dragon',selfHeal:0.17},{name:'毒牙',dmg:102,cost:13,type:'poison',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true},{name:'精神強擊',dmg:74,cost:8,type:'psychic',rider:'mega-charge',selfHeal:0.23}]},
  { id:250, name:'鳳王',       type:'fire',     type2:'flying',  hp:260, tier:3, ability:{id:'healing-rainbow', name:'治癒彩虹', trigger:'onDefend', desc:'被擊倒後可以復活一次，HP 回復 50%（整場戰鬥限一次）；不會受到任何負面狀態'}, attacks:[{name:'妖精威壓擊',dmg:54,cost:3,type:'fairy',rider:'self-cure',status:{effect:'paralysis', chance:0.4}},{name:'聖焰',dmg:73,cost:8,type:'fire',ignoreReflect:true,status:{effect:'burn', chance:1},status2:{effect:'poison',chance:1}},{name:'大地波動',dmg:80,cost:8,type:'ground',rider:'energy-steal'},{name:'怒風',dmg:100,cost:13,type:'flying',selfHeal:0.22,bonusVsType:'dragon'}]},
  { id:249, name:'洛奇亞',     type:'psychic',  type2:'flying',  hp:255, tier:3, ability:{id:'vortex-pressure', name:'漩渦威壓', trigger:'onDefend', desc:'牠在場上時，對手攻擊消耗的能量持續 +3；每回合開始 50% 機率抽到一張大海之盾'}, attacks:[{name:'幽靈球',dmg:43,cost:1,type:'ghost',rider:'mega-charge',status:{effect:'confusion', chance:0.4}},{name:'暴風',dmg:78,cost:7,type:'flying',rider:'type-draw',status:{effect:'sleep', chance:0.4}},{name:'冰凍光束',dmg:74,cost:7,type:'ice',rider:'guard-up'},{name:'未來雷霆',dmg:93,cost:12,type:'psychic',ignoreReflect:true,status:{effect:'freeze', chance:0.4},bonusVsType:'ghost'}]},
  { id:1007,name:'故勒頓',     type:'fighting', type2:'dragon',  hp:360, tier:3, ability:{id:'crimson-pulse', name:'緋紅脈動', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1；每回合開始必定額外抽到一張直搗黃龍'}, attacks:[{name:'火焰噴射',dmg:101,cost:14,type:'fire',megaBoost:true,bonusEnergy:7,bonusVsType:'steel',ignoreReflect:true},{name:'決勝衝擊',dmg:108,cost:14,type:'fighting',status:{effect:'burn', chance:0.4},bonusVsType:'bug'},{name:'泥巴射擊',dmg:104,cost:14,type:'ground',status:{effect:'sleep', chance:0.4},bonusVsType:'electric'},{name:'遠古之力',dmg:77,cost:9,type:'rock',rider:'energy-steal',selfHeal:0.3}]},
  { mega:{spriteId:10051, type:'psychic', type2:'fairy', ability:{id:'adaptability', name:'妖精皮膚', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:282, name:'沙奈朵',     type:'psychic',  type2:'fairy',   hp:205, tier:3, ability:{id:'sync-status', name:'同步', trigger:'onDefend', desc:'陷入中毒／麻痺／燒傷時，會將該狀態傳染給攻擊者'}, attacks:[{name:'毒針',dmg:43,cost:1,type:'poison',megaBoost:true,bonusEnergy:4},{name:'暗影球',dmg:78,cost:7,type:'ghost',selfHeal:0.26,bonusVsType:'psychic'},{name:'妖精之力',dmg:97,cost:12,type:'fairy',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true,ignoreShield:true},{name:'精神強擊',dmg:42,cost:1,type:'psychic',rider:'energy-steal',selfHeal:0.24}]},
  { id:144, name:'急凍鳥',     type:'ice',      type2:'flying',  hp:340, tier:3, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'暴風雪',dmg:74,cost:8,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'燕返',dmg:105,cost:13,type:'flying',ignoreReflect:true,status:{effect:'sleep', chance:0.4},bonusVsType:'bug'},{name:'幽冥威壓擊',dmg:101,cost:13,type:'ghost',selfHeal:0.22,bonusVsType:'ghost',ignoreReflect:true,ignoreShield:true},{name:'橫衝直撞',dmg:97,cost:13,type:'normal',selfHeal:0.25}]},
  { id:145, name:'閃電鳥',     type:'electric', type2:'flying',  hp:245, tier:3, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'龍爪',dmg:72,cost:7,type:'dragon',rider:'type-draw',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'猛禽炸彈',dmg:68,cost:7,type:'flying',status:{effect:'sleep', chance:0.4},bonusVsType:'fighting'},{name:'雷霆',dmg:98,cost:12,type:'electric',selfHeal:0.25,bonusVsType:'dragon'},{name:'吼叫',dmg:43,cost:1,type:'normal',rider:'type-draw',status:{effect:'paralysis', chance:0.4},status2:{effect:'poison',chance:0.4}}]},
  { id:146, name:'火焰鳥',     type:'fire',     type2:'flying',  hp:200, tier:3, ability:{id:'pressure', name:'壓迫感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'火焰衝擊',dmg:92,cost:11,type:'fire',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6,bonusVsType:'ice',ignoreReflect:true},{name:'超能力',dmg:40,cost:0,type:'psychic',rider:'energy-steal',status:{effect:'confusion', chance:0.4},selfHeal:0.16,status2:{effect:'burn',chance:0.4}},{name:'十萬伏特',dmg:72,cost:6,type:'electric',status:{effect:'paralysis', chance:0.4}},{name:'怒風',dmg:40,cost:0,type:'flying',ignoreReflect:true,selfHeal:0.28}]},
  { id:888,name:'蒼響',      type:'fairy',    type2:'steel',   hp:370, tier:3, ability:{id:'steel-domain', name:'鋼鐵支配', trigger:'onEnter', desc:'上場時場地切換為鋼鐵堡壘；鋼屬性攻擊傷害額外 +40'}, attacks:[{name:'接近戰',dmg:105,cost:14,type:'fighting',megaBoost:true,bonusEnergy:8},{name:'月亮力量',dmg:101,cost:14,type:'fairy',ignoreReflect:true,selfHeal:0.19,bonusVsType:'dark'},{name:'鐵頭功',dmg:108,cost:14,type:'steel',selfHeal:0.21,bonusVsType:'normal',ignoreReflect:true,ignoreShield:true},{name:'劇毒威壓擊',dmg:81,cost:9,type:'poison',selfHeal:0.18}]},
  { id:716, name:'哲爾尼亞斯', type:'fairy',    hp:305, tier:3, ability:{id:'adaptability', name:'妖精氣場', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}, attacks:[{name:'飛葉快刀',dmg:56,cost:4,type:'grass',rider:'type-draw'},{name:'十萬伏特',dmg:91,cost:10,type:'electric',status:{effect:'paralysis', chance:0.4},status2:{effect:'burn',chance:0.4}},{name:'魔法閃耀',dmg:110,cost:15,type:'fairy',rider:'card-steal'},{name:'冰耳光',dmg:106,cost:15,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'flying',ignoreReflect:true}]},
  { id:378, name:'雷吉艾斯',   type:'ice',      hp:370, tier:3, ability:{id:'thick-fat', name:'厚脂肪', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}, attacks:[{name:'暴風雪',dmg:108,cost:14,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:8,bonusVsType:'grass'},{name:'閃光炮',dmg:81,cost:9,type:'steel',rider:'self-cure',status:{effect:'paralysis', chance:0.4}},{name:'未來雷霆',dmg:100,cost:14,type:'psychic',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting'},{name:'電磁砲',dmg:107,cost:14,type:'electric',rider:'mega-charge',status:{effect:'burn', chance:0.4},status2:{effect:'freeze',chance:0.4}}]},
  { id:717, name:'伊裴爾塔爾', type:'dark',     type2:'flying',  hp:265, tier:3, ability:{id:'dark-abyss-lockdown', name:'深淵支配', trigger:'passive', desc:'對方無法使用 Mega 進化；這隻寶可夢在場上時，對方的寶可夢無法回復 HP'}, attacks:[{name:'幽靈球',dmg:53,cost:3,type:'ghost',ignoreReflect:true},{name:'空氣斬',dmg:77,cost:9,type:'flying',rider:'mega-charge',status:{effect:'freeze', chance:0.4},status2:{effect:'paralysis',chance:0.4}},{name:'大地虹吸',dmg:84,cost:9,type:'ground',rider:'life-drain'},{name:'惡意波動',dmg:103,cost:14,type:'dark',selfHeal:0.25,bonusVsType:'ghost'}]},
  { id:483, name:'帝牙盧卡',   type:'steel',    type2:'dragon',  hp:360, tier:3, ability:{id:'dragon-domain', name:'龍域降臨', trigger:'onEnter', desc:'上場時場地切換為龍之谷；龍屬性攻擊傷害額外 +40'}, attacks:[{name:'閃光炮',dmg:105,cost:13,type:'steel',ignoreReflect:true,megaBoost:true,bonusEnergy:7,bonusVsType:'fairy',ignoreShield:true},{name:'龍之脈動',dmg:101,cost:13,type:'dragon',selfHeal:0.19,bonusVsType:'dragon'},{name:'雷霆',dmg:73,cost:8,type:'electric',rider:'mega-charge',selfHeal:0.21},{name:'幽靈之爪',dmg:104,cost:13,type:'ghost',selfHeal:0.2}]},
  { id:484, name:'帕路奇亞',   type:'water',    type2:'dragon',  hp:200, tier:3, ability:{id:'dragon-domain', name:'龍域降臨', trigger:'onEnter', desc:'上場時場地切換為龍之谷；龍屬性攻擊傷害額外 +40'}, attacks:[{name:'鐵翼',dmg:40,cost:1,type:'steel',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'龍之脈動',dmg:47,cost:1,type:'dragon',status:{effect:'paralysis', chance:0.4}},{name:'空間扭曲',dmg:71,cost:7,type:'psychic',ignoreReflect:true,selfHeal:0.25,bonusVsType:'fighting',ignoreShield:true},{name:'衝浪',dmg:101,cost:12,type:'water',selfHeal:0.15,bonusVsType:'ice'}]},
  { id:727, name:'熾焰咆哮虎', type:'fire',     type2:'dark',    hp:300, tier:2, ability:{id:'dark-domain', name:'暗夜支配', trigger:'onEnter', desc:'上場時場地切換為暗夜詛咒領域；惡屬性攻擊傷害額外 +40'}, attacks:[{name:'超強衝擊',dmg:56,cost:4,type:'fighting',ignoreReflect:true,status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'sleep',chance:0.4}},{name:'暗黑強打',dmg:86,cost:9,type:'dark',megaBoost:true,bonusEnergy:7},{name:'火焰噴射',dmg:105,cost:14,type:'fire',status:{effect:'paralysis', chance:0.4},bonusVsType:'dark',ignoreReflect:true},{name:'劇毒威壓擊',dmg:101,cost:14,type:'poison',selfHeal:0.2,bonusVsType:'fairy'}]},
  // 新增：補足各屬性
  { id:128, name:'肯泰羅',     type:'normal',                    hp:240, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'夜襲',dmg:40,cost:0,type:'dark',rider:'energy-steal',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'灼熱吸血擊',dmg:73,cost:6,type:'fire',ignoreReflect:true,rider:'life-drain'},{name:'地震',dmg:69,cost:6,type:'ground',megaBoost:true,bonusEnergy:5},{name:'橫衝直撞',dmg:88,cost:11,type:'normal',selfHeal:0.21,bonusVsType:'psychic',ignoreReflect:true}]},
  { id:295, name:'爆音怪',     type:'normal',                    hp:240, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'疾風威壓擊',dmg:47,cost:1,type:'flying',rider:'self-cure'},{name:'大字爆炎',dmg:71,cost:7,type:'fire',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:4,rider:'card-steal'},{name:'衝浪',dmg:78,cost:7,type:'water',megaBoost:true,bonusEnergy:4,rider:'self-cure'},{name:'破壞光線',dmg:97,cost:12,type:'normal',status:{effect:'paralysis', chance:0.4},ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10065, type:'grass', type2:'dragon', ability:{id:'motor-drive', name:'避雷針', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:254, name:'蜥蜴王',     type:'grass',                     hp:260, tier:2, ability:{id:'blaze-boost', name:'茂盛', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'閃電拳',dmg:46,cost:2,type:'electric',rider:'mega-charge',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'confusion',chance:0.4}},{name:'能量球',dmg:105,cost:13,type:'grass',ignoreReflect:true,status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'大地之力',dmg:77,cost:8,type:'ground',megaBoost:true,bonusEnergy:5,rider:'move-reflect'},{name:'神速吸能擊',dmg:73,cost:8,type:'normal',rider:'self-cure'}]},
  { id:24,  name:'阿柏怪',     type:'poison',                    hp:200, tier:1, ability:{id:'poison-domain', name:'劇毒支配', trigger:'onEnter', desc:'上場時場地切換為劇毒領域；毒屬性攻擊傷害額外 +40'}, attacks:[{name:'纏繞',dmg:40,cost:0,type:'normal',rider:'mega-charge',status:{effect:'sleep', chance:0.4},megaBoost:true,bonusEnergy:4},{name:'地震',dmg:40,cost:0,type:'ground',rider:'type-draw',status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:4,status2:{effect:'confusion',chance:0.4}},{name:'毒牙',dmg:93,cost:11,type:'poison',megaBoost:true,bonusEnergy:4},{name:'鋼影護甲擊',dmg:66,cost:6,type:'steel',ignoreReflect:true,rider:'guard-up'}]},
  { id:73,  name:'毒刺水母',   type:'water',    type2:'poison',  hp:220, tier:1, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'蟲毒強奪擊',dmg:52,cost:3,type:'bug',rider:'energy-steal'},{name:'火花',dmg:59,cost:3,type:'fire',rider:'self-cure',status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'freeze',chance:0.4}},{name:'衝浪',dmg:83,cost:9,type:'water',megaBoost:true,bonusEnergy:7},{name:'毒液',dmg:102,cost:14,type:'poison',status:{effect:'burn', chance:0.4},bonusVsType:'bug',ignoreReflect:true}]},
  { id:454, name:'毒骷蛙',     type:'fighting', type2:'poison',  hp:230, tier:1, ability:{id:'water-absorb', name:'乾燥皮膚', trigger:'onDefend', desc:'受到水屬性攻擊時完全免疫，並回復最大HP的1/4'}, attacks:[{name:'妖精吸血擊',dmg:64,cost:5,type:'fairy',rider:'mega-charge',bonusVsType:'dragon'},{name:'夜襲',dmg:60,cost:5,type:'dark',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'十字劈',dmg:91,cost:10,type:'fighting',megaBoost:true,bonusEnergy:7,rider:'mega-charge'},{name:'劇毒威壓擊',dmg:110,cost:15,type:'poison',selfHeal:0.27,bonusVsType:'grass'}]},
  { id:553, name:'流氓鱷',     type:'ground',   type2:'dark',    hp:270, tier:2, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'岩石滑落',dmg:88,cost:10,type:'rock',rider:'energy-steal',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'freeze',chance:0.4}},{name:'激流威壓擊',dmg:60,cost:5,type:'water',rider:'self-cure'},{name:'地震',dmg:91,cost:10,type:'ground',megaBoost:true,bonusEnergy:7},{name:'暗黑強打',dmg:110,cost:15,type:'dark',ignoreReflect:true,selfHeal:0.24,bonusVsType:'ghost'}]},
  { id:641, name:'龍捲雲',     type:'flying',                    hp:290, tier:2, ability:{id:'prankster-heart', name:'惡作劇之心', trigger:'onAttack', desc:'每回合開始 50% 機率抽到一張精神干擾；沒抽到時下次攻擊威力 +20'}, attacks:[{name:'蟲刃剪',dmg:50,cost:2,type:'bug',rider:'type-draw',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:5},{name:'雷電',dmg:70,cost:7,type:'electric',rider:'energy-steal',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'空氣斬',dmg:100,cost:12,type:'flying',selfHeal:0.22,bonusVsType:'psychic'},{name:'飛葉快刀',dmg:96,cost:12,type:'grass',selfHeal:0.18,bonusVsType:'water',ignoreReflect:true}]},
  { mega:{spriteId:10308, type:'fighting', type2:'flying', ability:{id:'huge-power', name:'唱反調', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:398, name:'姆克鷹',     type:'normal',   type2:'flying',  hp:240, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'夜騷動',dmg:44,cost:1,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:4},{name:'暴風',dmg:63,cost:6,type:'flying',megaBoost:true,bonusEnergy:4},{name:'荒草吸能擊',dmg:70,cost:6,type:'grass',rider:'energy-steal'},{name:'神速吸能擊',dmg:89,cost:11,type:'normal',selfHeal:0.25,bonusVsType:'psychic',ignoreReflect:true,ignoreShield:true}]},
  { id:663, name:'烈箭鷹',     type:'fire',     type2:'flying',  hp:260, tier:2, ability:{id:'flame-body', name:'火焰之軀', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入燒傷'}, attacks:[{name:'幽靈球',dmg:50,cost:2,type:'ghost',rider:'energy-steal',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'freeze',chance:0.4}},{name:'空氣斬',dmg:70,cost:7,type:'flying',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:7},{name:'荒草護甲擊',dmg:77,cost:7,type:'grass',rider:'mega-charge'},{name:'炎翼衝刺',dmg:96,cost:12,type:'fire',selfHeal:0.2,bonusVsType:'ghost',ignoreReflect:true}]},
  { mega:{spriteId:10047, type:'bug', type2:'fighting', ability:{id:'huge-power', name:'連續攻擊', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:214, name:'赫拉克羅斯', type:'bug',      type2:'fighting',hp:270, tier:2, ability:{id:'guts', name:'毅力', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'妖精強奪擊',dmg:68,cost:5,type:'fairy',rider:'mega-charge'},{name:'地震',dmg:88,cost:10,type:'ground',megaBoost:true,bonusEnergy:8,rider:'card-steal'},{name:'聖甲蟲衝擊',dmg:84,cost:10,type:'bug',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'近身戰',dmg:110,cost:15,type:'fighting',ignoreReflect:true,status:{effect:'sleep', chance:0.4},bonusVsType:'normal'}]},
  { mega:{spriteId:10046, type:'bug', type2:'steel', ability:{id:'technician', name:'技術高手', trigger:'onAttack', desc:'威力 60 以下的招式，傷害 ×1.1'}}, id:212, name:'巨鉗螳螂',   type:'bug',      type2:'steel',   hp:260, tier:2, ability:{id:'blaze-boost', name:'蟲之預感', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'疾風吸血擊',dmg:55,cost:3,type:'flying',ignoreReflect:true,rider:'life-drain'},{name:'破魂吸血擊',dmg:74,cost:8,type:'fighting',megaBoost:true,bonusEnergy:6},{name:'蟲刃剪',dmg:81,cost:8,type:'bug',megaBoost:true,bonusEnergy:5},{name:'子彈拳',dmg:101,cost:13,type:'steel',selfHeal:0.23,bonusVsType:'rock',ignoreReflect:true,ignoreShield:true}]},
  { id:469, name:'遠古巨蜓',   type:'bug',      type2:'flying',  hp:230, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'實力全開',dmg:61,cost:5,type:'normal',rider:'mega-charge',status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'freeze',chance:0.4}},{name:'雷光威壓擊',dmg:68,cost:5,type:'electric',rider:'weaken'},{name:'蟲鳴',dmg:88,cost:10,type:'bug',megaBoost:true,bonusEnergy:7},{name:'空氣斬',dmg:107,cost:15,type:'flying',selfHeal:0.25,ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10049, type:'rock', type2:'dark', ability:{id:'solid-rock', name:'揚沙', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:248, name:'班基拉斯',   type:'rock',     type2:'dark',    hp:300, tier:2, ability:{id:'solid-rock', name:'揚沙', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'碎岩',dmg:101,cost:14,type:'rock',rider:'move-reflect',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:8},{name:'咬碎',dmg:85,cost:9,type:'dark',ignoreReflect:true,status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'sleep',chance:0.4}},{name:'地震',dmg:53,cost:3,type:'ground',selfHeal:0.21},{name:'踢腿',dmg:100,cost:14,type:'fighting',status:{effect:'sleep', chance:0.4},bonusVsType:'dark',ignoreReflect:true}]},
  { mega:{spriteId:10042, type:'rock', type2:'flying', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:142, name:'化石翼龍',   type:'rock',     type2:'flying',  hp:260, tier:2, ability:{id:'no-weakness-dodge', name:'深淵支配', trigger:'onDefend', desc:'不會受到超效傷害；10% 機率完全閃避攻擊'}, attacks:[{name:'咬碎',dmg:58,cost:3,type:'dark',ignoreReflect:true,status:{effect:'confusion', chance:0.4},megaBoost:true,bonusEnergy:7,status2:{effect:'paralysis',chance:0.4}},{name:'翼擊',dmg:82,cost:9,type:'flying',megaBoost:true,bonusEnergy:6},{name:'精神吸能擊',dmg:78,cost:9,type:'psychic',rider:'type-draw'},{name:'岩石炮',dmg:108,cost:14,type:'rock',selfHeal:0.2,bonusVsType:'ice',ignoreReflect:true}]},
  { id:526, name:'龐岩怪',     type:'rock',                      hp:280, tier:2, ability:{id:'rock-domain', name:'磐岩支配', trigger:'onEnter', desc:'上場時場地切換為岩石地帶；岩石屬性攻擊傷害額外 +40'}, attacks:[{name:'閃光炮',dmg:47,cost:1,type:'steel',rider:'type-draw',megaBoost:true,bonusEnergy:5},{name:'逆鱗護甲擊',dmg:71,cost:7,type:'dragon',rider:'energy-steal'},{name:'岩石炮',dmg:101,cost:12,type:'rock',status:{effect:'freeze', chance:0.4},bonusVsType:'rock'},{name:'地震',dmg:97,cost:12,type:'ground',status:{effect:'poison', chance:0.4},bonusVsType:'ice',ignoreReflect:true}]},
  { id:477, name:'黑夜魔靈',   type:'ghost',                     hp:220, tier:1, ability:{id:'ghost-domain', name:'亡靈支配', trigger:'onEnter', desc:'上場時場地切換為亡靈墓園；幽靈屬性攻擊傷害額外 +40'}, attacks:[{name:'月亮力量',dmg:80,cost:8,type:'fairy',ignoreReflect:true,status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'sleep',chance:0.4}},{name:'冰凍拳',dmg:48,cost:2,type:'ice',rider:'mega-charge',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6,status2:{effect:'paralysis',chance:0.4}},{name:'幽靈球',dmg:96,cost:13,type:'ghost',megaBoost:true,bonusEnergy:6},{name:'疾風強奪擊',dmg:51,cost:2,type:'flying',rider:'energy-steal'}]},
  { mega:{spriteId:10291, type:'ghost', type2:'fire', ability:{id:'frisk-ward', name:'穿透', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:609, name:'水晶燈火靈', type:'ghost',    type2:'fire',    hp:260, tier:2, ability:{id:'flash-fire', name:'引火', trigger:'onDefend', desc:'受到火屬性攻擊時完全免疫，下次攻擊威力 +20'}, attacks:[{name:'冰霜吸血擊',dmg:80,cost:8,type:'ice',rider:'life-drain'},{name:'空間扭曲',dmg:48,cost:2,type:'psychic',rider:'type-draw',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:5,status2:{effect:'confusion',chance:0.4}},{name:'暗影球',dmg:72,cost:8,type:'ghost',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'噴火',dmg:103,cost:13,type:'fire',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting',ignoreReflect:true}]},
  { mega:{spriteId:10057, type:'dark', type2:null, ability:{id:'frisk-ward', name:'魔法鏡', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:359, name:'阿勃梭魯',   type:'dark',                      hp:220, tier:1, ability:{id:'huge-power', name:'超幸運', trigger:'onAttack', desc:'攻擊傷害固定 +40'}, attacks:[{name:'鐵尾',dmg:75,cost:8,type:'steel',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'光合作用強擊',dmg:59,cost:3,type:'grass',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'妖精威壓擊',dmg:55,cost:3,type:'fairy',rider:'energy-steal'},{name:'夜斬',dmg:98,cost:13,type:'dark',selfHeal:0.26,bonusVsType:'rock',ignoreReflect:true}]},
  // ── +30 新增（最終進化型，非幻獸/神獸，無龍/妖精屬性）──
  { id:865, name:'蔥遊兵', type:'fighting',  hp:220, tier:1, ability:{id:'desperate-blade', name:'背水之刃', trigger:'onAttack', desc:'HP 低於 50% 時，攻擊傷害 +40'}, attacks:[{name:'連續攻擊',dmg:57,cost:4,type:'normal',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'鋼影吸能擊',dmg:64,cost:4,type:'steel',ignoreReflect:true,rider:'energy-steal'},{name:'暗黑脈衝',dmg:83,cost:9,type:'dark',status:{effect:'paralysis', chance:0.4},megaBoost:true,bonusEnergy:6},{name:'碎岩',dmg:102,cost:14,type:'fighting',selfHeal:0.18,bonusVsType:'ghost',ignoreReflect:true}]},
  { id:297, name:'鐵掌力士', type:'fighting',  hp:250, tier:1, ability:{id:'fighting-domain', name:'鬥氣支配', trigger:'onEnter', desc:'上場時場地切換為羅馬鬥技場；格鬥屬性攻擊傷害額外 +40'}, attacks:[{name:'突擊',dmg:40,cost:1,type:'normal',ignoreReflect:true,megaBoost:true,bonusEnergy:5},{name:'魔法閃耀',dmg:75,cost:7,type:'fairy',megaBoost:true,bonusEnergy:5},{name:'近身戰',dmg:94,cost:12,type:'fighting',selfHeal:0.22,bonusVsType:'dark',ignoreReflect:true,ignoreShield:true},{name:'蟲毒護甲擊',dmg:78,cost:7,type:'bug',rider:'energy-steal'}]},
  { id:342, name:'鐵螯龍蝦', type:'water', type2:'dark', hp:210, tier:1, ability:{id:'adaptability', name:'適應力', trigger:'onAttack', desc:'本系加成（STAB）提升為 ×1.2（原本 ×1.1）'}, attacks:[{name:'神速強奪擊',dmg:42,cost:1,type:'normal',ignoreReflect:true,rider:'card-steal'},{name:'泥巴射擊',dmg:49,cost:1,type:'ground',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'水槍',dmg:73,cost:7,type:'water',megaBoost:true,bonusEnergy:6},{name:'夜斬',dmg:92,cost:12,type:'dark',status:{effect:'burn', chance:0.4},bonusVsType:'rock',ignoreReflect:true}]},
  { id:660, name:'掘地兔', type:'normal', type2:'ground', hp:230, tier:1, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'岩崩',dmg:54,cost:4,type:'rock',rider:'self-cure',megaBoost:true,bonusEnergy:8},{name:'灼熱吸血擊',dmg:61,cost:4,type:'fire',rider:'type-draw'},{name:'衝撞',dmg:80,cost:9,type:'normal',megaBoost:true,bonusEnergy:7,rider:'life-drain'},{name:'地震',dmg:110,cost:14,type:'ground',ignoreReflect:true,selfHeal:0.21,bonusVsType:'fire'}]},
  { id:632, name:'鐵蟻', type:'steel', type2:'bug', hp:200, tier:1, ability:{id:'bug-domain', name:'蟲群支配', trigger:'onEnter', desc:'上場時場地切換為蟲群巢穴；蟲屬性攻擊傷害額外 +40'}, attacks:[{name:'冰霜威壓擊',dmg:73,cost:6,type:'ice',rider:'move-reflect'},{name:'電磁衝浪',dmg:46,cost:1,type:'electric',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'蟲咬',dmg:42,cost:1,type:'bug',megaBoost:true,bonusEnergy:5},{name:'金屬爪',dmg:95,cost:11,type:'steel',status:{effect:'paralysis', chance:0.4},bonusVsType:'water',ignoreReflect:true,ignoreShield:true}]},
  { id:558, name:'岩殿居蟹', type:'bug', type2:'rock', hp:240, tier:1, ability:{id:'status-immune-once', name:'淬鍊之心', trigger:'onStatus', desc:'首次被施加異常狀態時解除並免疫，之後攻擊傷害永久 +40'}, attacks:[{name:'烈火強衝',dmg:68,cost:6,type:'fire',rider:'energy-steal',megaBoost:true,bonusEnergy:4},{name:'荒草吸能擊',dmg:40,cost:0,type:'grass',rider:'self-cure'},{name:'岩石封鎖',dmg:71,cost:6,type:'rock',megaBoost:true,bonusEnergy:5},{name:'蟲咬',dmg:90,cost:11,type:'bug',ignoreReflect:true,status:{effect:'burn', chance:0.4},bonusVsType:'steel',ignoreShield:true}]},
  { id:105, name:'嘎啦嘎啦', type:'ground',  hp:220, tier:1, ability:{id:'guts', name:'堅韌', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'蟲毒護甲擊',dmg:50,cost:3,type:'bug',rider:'self-cure'},{name:'喊叫',dmg:57,cost:3,type:'normal',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'幽靈球',dmg:76,cost:8,type:'ghost',megaBoost:true,bonusEnergy:6},{name:'地震',dmg:96,cost:13,type:'ground',selfHeal:0.25,bonusVsType:'ghost',ignoreReflect:true,ignoreShield:true}]},
  { id:338, name:'太陽岩', type:'rock', type2:'psychic', hp:230, tier:1, ability:{id:'psychic-domain', name:'幻境支配', trigger:'onEnter', desc:'上場時場地切換為魔幻空間；超能力屬性攻擊傷害額外 +40'}, attacks:[{name:'夜襲',dmg:87,cost:10,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:7,ignoreReflect:true},{name:'念力',dmg:59,cost:5,type:'psychic',rider:'self-cure',megaBoost:true,bonusEnergy:7},{name:'岩石炮',dmg:110,cost:15,type:'rock',megaBoost:true,bonusEnergy:8,bonusVsType:'bug'},{name:'疾風強奪擊',dmg:62,cost:5,type:'flying',rider:'mega-charge'}]},
  { id:53, name:'貓老大', type:'normal',  hp:210, tier:1, ability:{id:'normal-domain', name:'神域支配', trigger:'onEnter', desc:'上場時場地切換為莊嚴神社；一般屬性攻擊傷害額外 +40'}, attacks:[{name:'岩崩吸血擊',dmg:51,cost:2,type:'rock',rider:'energy-steal'},{name:'音爆拳',dmg:47,cost:2,type:'fighting',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'啃咬',dmg:78,cost:7,type:'dark',megaBoost:true,bonusEnergy:5,rider:'guard-up'},{name:'吼叫',dmg:97,cost:12,type:'normal',ignoreReflect:true,status:{effect:'confusion', chance:0.4},ignoreShield:true}]},
  { id:508, name:'長毛狗', type:'normal',  hp:240, tier:1, ability:{id:'desperate-blade', name:'背水之刃', trigger:'onAttack', desc:'HP 低於 50% 時，攻擊傷害 +40'}, attacks:[{name:'火焰牙',dmg:44,cost:1,type:'fire',rider:'energy-steal',megaBoost:true,bonusEnergy:4},{name:'龍之隕星',dmg:68,cost:7,type:'dragon',megaBoost:true,bonusEnergy:4,rider:'self-cure'},{name:'破魂威壓擊',dmg:75,cost:7,type:'fighting',ignoreReflect:true,rider:'weaken'},{name:'咬住',dmg:94,cost:12,type:'normal',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:5,bonusVsType:'grass'}]},
  { id:134, name:'水伊布', type:'water',  hp:260, tier:1, ability:{id:'drizzle-ocean', name:'海洋支配', trigger:'onEnter', desc:'上場時場地切換為海洋世界；水／冰屬性攻擊傷害額外 +40'}, attacks:[{name:'冰凍光束',dmg:53,cost:3,type:'ice',rider:'mega-charge',megaBoost:true,bonusEnergy:6,bonusVsType:'rock'},{name:'岩石碎裂',dmg:72,cost:8,type:'fighting',megaBoost:true,bonusEnergy:6,rider:'move-reflect'},{name:'暗影吸能擊',dmg:79,cost:8,type:'dark',rider:'energy-steal'},{name:'水槍',dmg:99,cost:13,type:'water',ignoreReflect:true,status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:7}]},
  { mega:{spriteId:10090, type:'bug', type2:'poison', ability:{id:'adaptability', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:15, name:'大針蜂', type:'bug', type2:'poison', hp:200, tier:1, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'閃電拳',dmg:43,cost:0,type:'electric',rider:'self-cure',megaBoost:true,bonusEnergy:5,bonusVsType:'dark'},{name:'毒針',dmg:40,cost:0,type:'poison',ignoreReflect:true,megaBoost:true,bonusEnergy:5},{name:'針刺',dmg:86,cost:11,type:'bug',megaBoost:true,bonusEnergy:5,bonusVsType:'water'},{name:'冰霜護甲擊',dmg:70,cost:6,type:'ice',rider:'self-cure'}]},
  { id:411, name:'護城龍', type:'rock', type2:'steel', hp:220, tier:1, ability:{id:'rock-domain', name:'磐岩支配', trigger:'onEnter', desc:'上場時場地切換為岩石地帶；岩石屬性攻擊傷害額外 +40'}, attacks:[{name:'金屬音',dmg:57,cost:3,type:'steel',rider:'type-draw',megaBoost:true,bonusEnergy:6,bonusVsType:'fairy'},{name:'頭槌',dmg:53,cost:3,type:'normal',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'岩崩',dmg:96,cost:13,type:'rock',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'妖精強奪擊',dmg:79,cost:8,type:'fairy',rider:'self-cure'}]},
  { mega:{spriteId:10064, type:'water', type2:'ground', ability:{id:'huge-power', name:'飛毛腿', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:260, name:'巨沼怪', type:'water', type2:'ground', hp:300, tier:2, ability:{id:'blaze-boost', name:'激流', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'精神吸血擊',dmg:52,cost:3,type:'psychic',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'泥巴射擊',dmg:87,cost:9,type:'ground',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'水槍',dmg:106,cost:14,type:'water',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting',ignoreReflect:true},{name:'冰凍拳',dmg:102,cost:14,type:'ice',status:{effect:'confusion', chance:0.4},bonusVsType:'flying'}]},
  { id:407, name:'羅絲雷朵', type:'grass', type2:'poison', hp:270, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'激流吸血擊',dmg:77,cost:9,type:'water',ignoreReflect:true,rider:'life-drain'},{name:'噴火',dmg:84,cost:9,type:'fire',megaBoost:true,bonusEnergy:7,rider:'weaken'},{name:'毒粉刺',dmg:57,cost:4,type:'poison',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'魔法葉',dmg:110,cost:14,type:'grass',status:{effect:'burn', chance:0.4},bonusVsType:'ice'}]},
  { id:724, name:'狙射樹梟', type:'grass', type2:'ghost', hp:290, tier:2, ability:{id:'grass-domain', name:'密林支配', trigger:'onEnter', desc:'上場時場地切換為邪惡森林；草屬性攻擊傷害額外 +40'}, attacks:[{name:'烈焰衝浪腳',dmg:51,cost:2,type:'fire',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'影子偷襲',dmg:75,cost:8,type:'ghost',rider:'type-draw',megaBoost:true,bonusEnergy:6},{name:'飛葉快刀',dmg:106,cost:13,type:'grass',status:{effect:'burn', chance:0.4},bonusVsType:'ice',ignoreReflect:true},{name:'猛禽炸彈',dmg:102,cost:13,type:'flying',selfHeal:0.25,bonusVsType:'fighting'}]},
  { id:452, name:'龍王蠍', type:'poison', type2:'dark', hp:280, tier:2, ability:{id:'poison-domain', name:'劇毒支配', trigger:'onEnter', desc:'上場時場地切換為劇毒領域；毒屬性攻擊傷害額外 +40'}, attacks:[{name:'毒針',dmg:40,cost:0,type:'poison',ignoreReflect:true,status:{effect:'poison', chance:0.4},megaBoost:true,bonusEnergy:4,status2:{effect:'sleep',chance:0.4}},{name:'夜斬',dmg:95,cost:11,type:'dark',megaBoost:true,bonusEnergy:4},{name:'疾風威壓擊',dmg:68,cost:6,type:'flying',rider:'energy-steal'},{name:'地震',dmg:87,cost:11,type:'ground',status:{effect:'sleep', chance:0.4},bonusVsType:'rock',ignoreReflect:true}]},
  { id:862, name:'堵攔熊', type:'dark', type2:'normal', hp:300, tier:2, ability:{id:'guts', name:'堅韌', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'空間扭曲',dmg:85,cost:9,type:'dragon',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'高周波音',dmg:58,cost:4,type:'normal',rider:'mega-charge',megaBoost:true,bonusEnergy:6},{name:'未來雷霆',dmg:100,cost:14,type:'psychic',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting'},{name:'夜斬',dmg:107,cost:14,type:'dark',selfHeal:0.2,bonusVsType:'dragon',ignoreReflect:true}]},
  { id:738, name:'鍬農炮蟲', type:'bug', type2:'electric', hp:270, tier:2, ability:{id:'desperate-blade', name:'背水之刃', trigger:'onAttack', desc:'HP 低於 50% 時，攻擊傷害 +40'}, attacks:[{name:'蟲咬',dmg:56,cost:4,type:'bug',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'電磁炮',dmg:109,cost:14,type:'electric',megaBoost:true,bonusEnergy:8,bonusVsType:'water'},{name:'幽冥威壓擊',dmg:82,cost:9,type:'ghost',megaBoost:true,bonusEnergy:7,rider:'type-draw'},{name:'妖精吸能擊',dmg:78,cost:9,type:'fairy',ignoreReflect:true,rider:'energy-steal'}]},
  { mega:{spriteId:10313, type:'ground', type2:'ghost', ability:{id:'tough-claws', name:'隱形拳', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:623, name:'泥偶巨人', type:'ground', type2:'ghost', hp:310, tier:2, ability:{id:'retaliate-boost', name:'反骨', trigger:'onDefend', desc:'受到攻擊後，下次攻擊傷害 ×1.1'}, attacks:[{name:'百萬針',dmg:85,cost:10,type:'bug',rider:'mega-charge',megaBoost:true,bonusEnergy:8},{name:'幽靈球',dmg:68,cost:5,type:'ghost',rider:'self-cure',megaBoost:true,bonusEnergy:8},{name:'大地虹吸',dmg:110,cost:15,type:'ground',selfHeal:0.22,bonusVsType:'psychic'},{name:'冰霜拳',dmg:107,cost:15,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'grass',ignoreReflect:true}]},
  { mega:{spriteId:10280, type:'water', type2:'psychic', ability:{id:'huge-power', name:'大力士', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:121, name:'寶石海星', type:'water', type2:'psychic', hp:270, tier:2, ability:{id:'frisk-ward', name:'神秘之守', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'近身戰',dmg:82,cost:10,type:'fighting',rider:'type-draw',megaBoost:true,bonusEnergy:8},{name:'精神強擊',dmg:89,cost:10,type:'psychic',megaBoost:true,bonusEnergy:8},{name:'蟲毒護甲擊',dmg:61,cost:5,type:'bug',rider:'self-cure'},{name:'水槍',dmg:110,cost:15,type:'water',ignoreReflect:true,selfHeal:0.15,bonusVsType:'ice',ignoreShield:true}]},
  { mega:{spriteId:10045, type:'electric', type2:'dragon', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對方的防禦型特性'}}, id:181, name:'電龍', type:'electric',  hp:300, tier:2, ability:{id:'static', name:'靜電', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入麻痺'}, attacks:[{name:'精神護甲擊',dmg:64,cost:4,type:'psychic',rider:'type-draw',megaBoost:true,bonusEnergy:6},{name:'衝撞',dmg:83,cost:9,type:'normal',megaBoost:true,bonusEnergy:6},{name:'冰霜護甲擊',dmg:102,cost:14,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'電擊',dmg:109,cost:14,type:'electric',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting',ignoreReflect:true}]},
  { mega:{spriteId:10316, type:'bug', type2:'steel', ability:{id:'solid-rock', name:'重甲化', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:768, name:'具甲武者', type:'bug', type2:'water', hp:290, tier:2, ability:{id:'retaliate-boost', name:'反骨', trigger:'onDefend', desc:'受到攻擊後，下次攻擊傷害 ×1.1'}, attacks:[{name:'聖焰',dmg:75,cost:7,type:'fire',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'蟲咬',dmg:43,cost:1,type:'bug',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'大浪',dmg:101,cost:12,type:'water',selfHeal:0.17,bonusVsType:'ice'},{name:'雷光威壓擊',dmg:97,cost:12,type:'electric',status:{effect:'paralysis', chance:0.4},bonusVsType:'water',ignoreReflect:true}]},
  { id:465, name:'巨蔓藤', type:'grass',  hp:310, tier:2, ability:{id:'grass-domain', name:'密林支配', trigger:'onEnter', desc:'上場時場地切換為邪惡森林；草屬性攻擊傷害額外 +40'}, attacks:[{name:'實力全開',dmg:60,cost:4,type:'normal',rider:'self-cure',megaBoost:true,bonusEnergy:7},{name:'灼熱吸血擊',dmg:79,cost:9,type:'fire',ignoreReflect:true,megaBoost:true,bonusEnergy:8},{name:'光合作用強擊',dmg:109,cost:14,type:'grass',status:{effect:'confusion', chance:0.4},ignoreReflect:true},{name:'惡意突刺',dmg:105,cost:14,type:'poison',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true}]},
  { id:713, name:'冰岩怪', type:'ice',  hp:320, tier:2, ability:{id:'no-weakness-dodge', name:'深淵支配', trigger:'onDefend', desc:'不會受到超效傷害；10% 機率完全閃避攻擊'}, attacks:[{name:'毒液',dmg:98,cost:12,type:'poison',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:4},{name:'碎岩',dmg:94,cost:12,type:'rock',ignoreReflect:true,selfHeal:0.24,bonusVsType:'flying',ignoreShield:true},{name:'雪崩',dmg:101,cost:12,type:'ice',status:{effect:'poison', chance:0.4},bonusVsType:'grass'},{name:'光合作用強擊',dmg:74,cost:7,type:'grass',rider:'mega-charge',selfHeal:0.17}]},
  { id:576, name:'哥德小姐', type:'psychic',  hp:280, tier:2, ability:{id:'chance-debuff', name:'穿透', trigger:'onAttack', desc:'攻擊命中後 25% 機率讓對方下次攻擊傷害 ×0.9'}, attacks:[{name:'冰耳光',dmg:43,cost:0,type:'ice',rider:'type-draw',megaBoost:true,bonusEnergy:5},{name:'雷光強奪擊',dmg:67,cost:6,type:'electric',rider:'energy-steal'},{name:'幽冥威壓擊',dmg:86,cost:11,type:'ghost',selfHeal:0.2,bonusVsType:'ghost'},{name:'念力',dmg:93,cost:11,type:'psychic',ignoreReflect:true,status:{effect:'freeze', chance:0.4},bonusVsType:'flying'}]},
  { mega:{spriteId:10048, type:'dark', type2:'fire', ability:{id:'blaze-boost', name:'太陽之力', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:229, name:'黑魯加', type:'fire', type2:'dark', hp:280, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'水之脈動',dmg:47,cost:1,type:'water',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'火焰牙',dmg:94,cost:12,type:'fire',status:{effect:'burn', chance:0.4},megaBoost:true,bonusEnergy:5,bonusVsType:'ice'},{name:'惡意波動',dmg:101,cost:12,type:'dark',ignoreReflect:true,selfHeal:0.26,bonusVsType:'ground'},{name:'精神吸血擊',dmg:74,cost:7,type:'psychic',rider:'self-cure'}]},
  { id:464, name:'超甲狂犀', type:'ground', type2:'rock', hp:360, tier:3, ability:{id:'ground-domain', name:'風沙支配', trigger:'onEnter', desc:'上場時場地切換為沙塵暴；地面屬性攻擊傷害額外 +40'}, attacks:[{name:'角撞',dmg:104,cost:14,type:'normal',ignoreReflect:true,megaBoost:true,bonusEnergy:8},{name:'泥巴射擊',dmg:100,cost:14,type:'ground',selfHeal:0.18},{name:'岩崩',dmg:107,cost:14,type:'rock',status:{effect:'confusion', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'惡意突刺',dmg:80,cost:9,type:'poison',rider:'self-cure',status:{effect:'poison', chance:0.4},status2:{effect:'confusion',chance:0.4}}]},
  { id:473, name:'象牙豬', type:'ice', type2:'ground', hp:235, tier:3, ability:{id:'weaken-buffs', name:'威壓氣場', trigger:'onDefend', desc:'對手的攻擊力提升效果減半'}, attacks:[{name:'雪崩',dmg:63,cost:6,type:'ice',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6,bonusVsType:'ground'},{name:'地震',dmg:93,cost:11,type:'ground',selfHeal:0.28,bonusVsType:'steel'},{name:'啃咬',dmg:66,cost:6,type:'dark',status:{effect:'freeze', chance:0.4},selfHeal:0.25,status2:{effect:'sleep',chance:0.4}},{name:'毒針',dmg:45,cost:0,type:'poison',rider:'mega-charge',status:{effect:'poison', chance:0.4},status2:{effect:'freeze',chance:0.4}}]},
  { id:625, name:'劈斬司令', type:'dark', type2:'steel', hp:295, tier:3, ability:{id:'guts', name:'堅韌', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'金屬爪',dmg:103,cost:13,type:'steel',megaBoost:true,bonusEnergy:5,bonusVsType:'ice'},{name:'夜斬',dmg:99,cost:13,type:'dark',ignoreReflect:true,selfHeal:0.16,bonusVsType:'ghost'},{name:'水炮',dmg:59,cost:3,type:'water',rider:'mega-charge',selfHeal:0.23},{name:'念力衝擊',dmg:78,cost:8,type:'psychic',rider:'type-draw',selfHeal:0.3}]},
  /* ── Mega 進化擴充（Legends Z-A / 原有 46 種缺漏補完） ── */
  { mega:{spriteId:10073, type:'normal', type2:'flying', ability:{id:'huge-power', name:'無防守', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:18, name:'大比鳥', type:'normal', type2:'flying', hp:220, tier:1, ability:{id:'frisk-ward', name:'牽制', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'幽冥威壓擊',dmg:52,cost:3,type:'ghost',rider:'energy-steal',megaBoost:true,bonusEnergy:6,bonusVsType:'bug'},{name:'電光一閃',dmg:59,cost:3,type:'normal',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'破空飛翔',dmg:102,cost:13,type:'flying',megaBoost:true,bonusEnergy:6,bonusVsType:'ghost'},{name:'劇毒威壓擊',dmg:74,cost:8,type:'poison',rider:'weaken'}]},
  { mega:{spriteId:10039, type:'normal', type2:null, ability:{id:'huge-power', name:'親子羈絆', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:115, name:'袋獸', type:'normal', hp:280, tier:2, ability:{id:'status-immune-once', name:'淬鍊之心', trigger:'onStatus', desc:'首次被施加異常狀態時解除並免疫，之後攻擊傷害永久 +40'}, attacks:[{name:'地震',dmg:50,cost:1,type:'ground',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'咬碎',dmg:97,cost:12,type:'dark',megaBoost:true,bonusEnergy:5},{name:'破魂吸能擊',dmg:70,cost:7,type:'fighting',ignoreReflect:true,rider:'energy-steal'},{name:'拍打',dmg:100,cost:12,type:'normal',status:{effect:'sleep', chance:0.4},bonusVsType:'steel',ignoreReflect:true}]},
  { mega:{spriteId:10040, type:'bug', type2:'flying', ability:{id:'adaptability', name:'飛行皮膚', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:127, name:'凱羅斯', type:'bug', hp:210, tier:1, ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對方的防禦型特性'}, attacks:[{name:'石頭砸落',dmg:45,cost:2,type:'rock',ignoreReflect:true,megaBoost:true,bonusEnergy:5,rider:'self-cure'},{name:'精神護甲擊',dmg:52,cost:2,type:'psychic',rider:'mega-charge'},{name:'綁緊',dmg:76,cost:8,type:'normal',megaBoost:true,bonusEnergy:5,rider:'card-steal'},{name:'斷頭台',dmg:96,cost:13,type:'bug',status:{effect:'confusion', chance:0.4},bonusVsType:'flying'}]},
  { mega:{spriteId:10072, type:'steel', type2:'ground', ability:{id:'blaze-boost', name:'沙之力', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:208, name:'大鋼蛇', type:'steel', type2:'ground', hp:290, tier:2, ability:{id:'item-synergy', name:'機械之心', trigger:'onAttack', desc:'本回合使用過道具卡時，攻擊傷害 +40'}, attacks:[{name:'綁緊',dmg:58,cost:3,type:'normal',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'大浪',dmg:77,cost:8,type:'water',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'地震',dmg:97,cost:13,type:'ground',selfHeal:0.17,bonusVsType:'poison'},{name:'鐵尾',dmg:104,cost:13,type:'steel',selfHeal:0.2,bonusVsType:'ground',ignoreReflect:true}]},
  { mega:{spriteId:10050, type:'fire', type2:'fighting', ability:{id:'huge-power', name:'加速', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:257, name:'火焰雞', type:'fire', type2:'fighting', hp:260, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'冰霜強奪擊',dmg:80,cost:8,type:'ice',ignoreReflect:true,megaBoost:true,bonusEnergy:7,rider:'move-reflect'},{name:'火花',dmg:53,cost:3,type:'fire',megaBoost:true,bonusEnergy:7,rider:'guard-up'},{name:'居合斬',dmg:72,cost:8,type:'dark',megaBoost:true,bonusEnergy:7,rider:'weaken'},{name:'踢腿',dmg:103,cost:13,type:'fighting',rider:'move-reflect'}]},
  { mega:{spriteId:10066, type:'dark', type2:'ghost', ability:{id:'frisk-ward', name:'魔法鏡', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:302, name:'勾魂眼', type:'dark', type2:'ghost', hp:200, tier:1, ability:{id:'shield-invert', name:'顛倒之心', trigger:'onDefend', desc:'對手的防禦加成效果對自己反而變成傷害加成'}, attacks:[{name:'暗影球',dmg:50,cost:1,type:'ghost',ignoreReflect:true,megaBoost:true,bonusEnergy:5},{name:'蟲毒吸血擊',dmg:46,cost:1,type:'bug',ignoreReflect:true,rider:'life-drain'},{name:'寶石爆破',dmg:70,cost:7,type:'rock',megaBoost:true,bonusEnergy:5},{name:'暗黑爆破',dmg:100,cost:12,type:'dark',selfHeal:0.25,bonusVsType:'psychic',ignoreReflect:true}]},
  { mega:{spriteId:10052, type:'steel', type2:'fairy', ability:{id:'huge-power', name:'大力士', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:303, name:'大嘴娃', type:'steel', type2:'fairy', hp:200, tier:1, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'啃咬',dmg:40,cost:0,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:4},{name:'毒牙',dmg:43,cost:0,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:4},{name:'幽冥威壓擊',dmg:67,cost:6,type:'ghost',rider:'weaken'},{name:'鐵頭',dmg:86,cost:11,type:'steel',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true}]},
  { mega:{spriteId:10053, type:'steel', type2:null, ability:{id:'solid-rock', name:'過濾', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:306, name:'波士可多拉', type:'steel', type2:'rock', hp:200, tier:2, ability:{id:'sturdy', name:'結實', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}, attacks:[{name:'雪崩',dmg:47,cost:1,type:'ice',rider:'self-cure',megaBoost:true,bonusEnergy:8},{name:'岩石滑落',dmg:43,cost:1,type:'rock',rider:'energy-steal',megaBoost:true,bonusEnergy:8},{name:'幽冥威壓擊',dmg:73,cost:6,type:'ghost',selfHeal:0.18,bonusVsType:'ghost'},{name:'金屬爪',dmg:92,cost:11,type:'steel',status:{effect:'freeze', chance:0.4},bonusVsType:'ground',ignoreReflect:true}]},
  { mega:{spriteId:10054, type:'fighting', type2:'psychic', ability:{id:'huge-power', name:'驚人怪力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:308, name:'恰雷姆', type:'fighting', type2:'psychic', hp:210, tier:1, ability:{id:'huge-power', name:'驚人怪力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}, attacks:[{name:'惡意彈珠',dmg:44,cost:2,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:5},{name:'念力',dmg:51,cost:2,type:'psychic',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'岩崩吸能擊',dmg:71,cost:7,type:'rock',rider:'energy-steal'},{name:'氣功拳',dmg:101,cost:12,type:'fighting',ignoreReflect:true,selfHeal:0.3,bonusVsType:'psychic'}]},
  { mega:{spriteId:10055, type:'electric', type2:null, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}}, id:310, name:'雷電獸', type:'electric', hp:230, tier:1, ability:{id:'static', name:'靜電', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者陷入麻痺'}, attacks:[{name:'火焰牙',dmg:62,cost:5,type:'fire',rider:'energy-steal',megaBoost:true,bonusEnergy:8},{name:'大地護甲擊',dmg:58,cost:5,type:'ground',ignoreReflect:true,rider:'guard-up'},{name:'吼叫',dmg:89,cost:10,type:'normal',megaBoost:true,bonusEnergy:8,rider:'mega-charge'},{name:'十萬伏特',dmg:108,cost:15,type:'electric',selfHeal:0.26,bonusVsType:'steel'}]},
  { mega:{spriteId:10070, type:'water', type2:'dark', ability:{id:'tough-claws', name:'強壯之顎', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:319, name:'巨牙鯊', type:'water', type2:'dark', hp:220, tier:1, ability:{id:'rough-skin', name:'粗糙皮膚', trigger:'onDefend', desc:'受到攻擊傷害時，反彈攻擊者 1/8 最大HP 傷害'}, attacks:[{name:'冰牙',dmg:54,cost:4,type:'ice',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'劇毒強奪擊',dmg:84,cost:9,type:'poison',rider:'move-reflect'},{name:'咬碎',dmg:57,cost:4,type:'dark',megaBoost:true,bonusEnergy:8},{name:'衝浪',dmg:110,cost:14,type:'water',selfHeal:0.18,bonusVsType:'grass',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10087, type:'fire', type2:'ground', ability:{id:'tough-claws', name:'強行', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:323, name:'噴火駝', type:'fire', type2:'ground', hp:260, tier:2, ability:{id:'solid-rock', name:'硬岩', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'鐵頭',dmg:57,cost:3,type:'steel',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'泥巴射擊',dmg:76,cost:8,type:'ground',megaBoost:true,bonusEnergy:6},{name:'幽冥吸血擊',dmg:72,cost:8,type:'ghost',ignoreReflect:true,rider:'life-drain'},{name:'火花',dmg:103,cost:13,type:'fire',status:{effect:'sleep', chance:0.4},bonusVsType:'rock',ignoreReflect:true}]},
  { mega:{spriteId:10067, type:'dragon', type2:'fairy', ability:{id:'adaptability', name:'妖精皮膚', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:334, name:'七夕青鳥', type:'dragon', type2:'flying', hp:270, tier:2, ability:{id:'frisk-ward', name:'自然回復', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'劇毒強奪擊',dmg:66,cost:5,type:'poison',rider:'mega-charge',megaBoost:true,bonusEnergy:7,bonusVsType:'fighting'},{name:'龍之氣息',dmg:86,cost:10,type:'dragon',megaBoost:true,bonusEnergy:8,rider:'mega-charge'},{name:'啄',dmg:105,cost:15,type:'flying',megaBoost:true,bonusEnergy:7,bonusVsType:'fairy'},{name:'荒草威壓擊',dmg:89,cost:10,type:'grass',rider:'type-draw'}]},
  { mega:{spriteId:10056, type:'ghost', type2:null, ability:{id:'frisk-ward', name:'惡作劇之心', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:354, name:'詛咒娃娃', type:'ghost', hp:210, tier:1, ability:{id:'shield-invert', name:'顛倒之心', trigger:'onDefend', desc:'對手的防禦加成效果對自己反而變成傷害加成'}, attacks:[{name:'空間扭曲',dmg:44,cost:1,type:'psychic',rider:'mega-charge',megaBoost:true,bonusEnergy:5},{name:'雷光吸能擊',dmg:40,cost:1,type:'electric',rider:'type-draw'},{name:'暗黑爆破',dmg:75,cost:7,type:'dark',megaBoost:true,bonusEnergy:5,rider:'life-drain'},{name:'暗影球',dmg:94,cost:12,type:'ghost',ignoreReflect:true,selfHeal:0.19,bonusVsType:'poison'}]},
  { mega:{spriteId:10074, type:'ice', type2:null, ability:{id:'adaptability', name:'冰肌', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:362, name:'冰鬼護', type:'ice', hp:260, tier:2, ability:{id:'thick-fat', name:'冰凍之軀', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}, attacks:[{name:'暗黑爆破',dmg:81,cost:8,type:'dark',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'激流護甲擊',dmg:54,cost:3,type:'water',rider:'mega-charge'},{name:'鐵頭',dmg:73,cost:8,type:'steel',megaBoost:true,bonusEnergy:6},{name:'冰耳光',dmg:104,cost:13,type:'ice',selfHeal:0.2,bonusVsType:'psychic',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10089, type:'dragon', type2:'flying', ability:{id:'adaptability', name:'飛行皮膚', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:373, name:'暴飛龍', type:'dragon', type2:'flying', hp:220, tier:3, ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}, attacks:[{name:'咬碎',dmg:86,cost:9,type:'dark',megaBoost:true,bonusEnergy:6,bonusVsType:'psychic',ignoreReflect:true},{name:'冰霜吸血擊',dmg:59,cost:4,type:'ice',selfHeal:0.27},{name:'龍之氣息',dmg:101,cost:14,type:'dragon',status:{effect:'freeze', chance:0.4},bonusVsType:'flying'},{name:'燕返',dmg:62,cost:4,type:'flying',rider:'mega-charge',status:{effect:'confusion', chance:0.4},status2:{effect:'sleep',chance:0.4}}]},
  { mega:{spriteId:10062, type:'dragon', type2:'psychic', ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:380, name:'拉帝亞斯', type:'dragon', type2:'psychic', hp:320, tier:3, ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'念力',dmg:92,cost:12,type:'psychic',megaBoost:true,bonusEnergy:4},{name:'龍之氣息',dmg:99,cost:12,type:'dragon',status:{effect:'sleep', chance:0.4},bonusVsType:'dragon'},{name:'魔法閃耀',dmg:95,cost:12,type:'fairy',status:{effect:'freeze', chance:0.4},bonusVsType:'fighting',ignoreReflect:true},{name:'熔岩爆發',dmg:68,cost:7,type:'fire',rider:'type-draw',status:{effect:'burn', chance:0.4},status2:{effect:'poison',chance:0.4}}]},
  { mega:{spriteId:10063, type:'dragon', type2:'psychic', ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:381, name:'拉帝歐斯', type:'dragon', type2:'psychic', hp:320, tier:3, ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'龍之隕星',dmg:94,cost:12,type:'dragon',megaBoost:true,bonusEnergy:4},{name:'念力',dmg:101,cost:12,type:'psychic',status:{effect:'burn', chance:0.4},bonusVsType:'fighting',ignoreReflect:true},{name:'冷凍光線',dmg:97,cost:12,type:'ice',selfHeal:0.23,bonusVsType:'flying',ignoreReflect:true,ignoreShield:true},{name:'地震',dmg:70,cost:7,type:'ground',selfHeal:0.16}]},
  { mega:{spriteId:10088, type:'normal', type2:'fighting', ability:{id:'huge-power', name:'根性', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:428, name:'長耳兔', type:'normal', hp:220, tier:1, ability:{id:'frisk-ward', name:'魅力', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'岩石碎裂',dmg:86,cost:9,type:'fighting',rider:'energy-steal',megaBoost:true,bonusEnergy:6,ignoreReflect:true},{name:'連續切',dmg:59,cost:4,type:'bug',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'破壞光線',dmg:101,cost:14,type:'normal',megaBoost:true,bonusEnergy:6,bonusVsType:'normal'},{name:'精神強奪擊',dmg:62,cost:4,type:'psychic',rider:'mega-charge'}]},
  { mega:{spriteId:10060, type:'grass', type2:'ice', ability:{id:'solid-rock', name:'降雪', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:460, name:'暴雪王', type:'grass', type2:'ice', hp:280, tier:2, ability:{id:'solid-rock', name:'降雪', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'劇毒強奪擊',dmg:47,cost:1,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'魔法葉',dmg:94,cost:12,type:'grass',megaBoost:true,bonusEnergy:4},{name:'冰霜拳',dmg:101,cost:12,type:'ice',ignoreReflect:true,status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreShield:true},{name:'破魂吸血擊',dmg:74,cost:7,type:'fighting',rider:'type-draw'}]},
  { mega:{spriteId:10068, type:'psychic', type2:'fighting', ability:{id:'huge-power', name:'精神力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:475, name:'艾路雷朵', type:'psychic', type2:'fighting', hp:260, tier:2, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'十萬伏特',dmg:81,cost:9,type:'electric',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'念力',dmg:77,cost:9,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'妖精威壓擊',dmg:61,cost:4,type:'fairy',rider:'mega-charge'},{name:'踢腿',dmg:103,cost:14,type:'fighting',ignoreReflect:true,status:{effect:'paralysis', chance:0.4},bonusVsType:'flying',ignoreShield:true}]},
  { mega:{spriteId:10069, type:'normal', type2:'fairy', ability:{id:'thick-fat', name:'治癒之心', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}}, id:531, name:'差不多娃娃', type:'normal', hp:300, tier:2, ability:{id:'thick-fat', name:'回復力', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}, attacks:[{name:'魔法閃耀',dmg:55,cost:3,type:'fairy',rider:'type-draw',megaBoost:true,bonusEnergy:6},{name:'大地護甲擊',dmg:74,cost:8,type:'ground',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'拍打',dmg:105,cost:13,type:'normal',selfHeal:0.28,bonusVsType:'dark'},{name:'日光束',dmg:101,cost:13,type:'grass',selfHeal:0.29,bonusVsType:'ground',ignoreReflect:true}]},
  { mega:{spriteId:10075, type:'rock', type2:'fairy', ability:{id:'frisk-ward', name:'魔法鏡', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:719, name:'蒂安希', type:'rock', type2:'fairy', hp:300, tier:3, ability:{id:'solid-rock', name:'恆淨之軀', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'閃光炮',dmg:85,cost:9,type:'steel',rider:'mega-charge',megaBoost:true,bonusEnergy:7},{name:'魔法閃耀',dmg:58,cost:4,type:'fairy',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'破魂強奪擊',dmg:100,cost:14,type:'fighting',status:{effect:'sleep', chance:0.4},bonusVsType:'steel'},{name:'岩石滑落',dmg:107,cost:14,type:'rock',selfHeal:0.21,bonusVsType:'rock',ignoreReflect:true}]},
  { mega:{spriteId:10278, type:'fairy', type2:'flying', ability:{id:'frisk-ward', name:'魔法鏡', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}}, id:36, name:'皮可西', type:'fairy', hp:280, tier:2, ability:{id:'magic-guard', name:'魔法防守', trigger:'onStatus', desc:'不會受到中毒／燒傷的傷害'}, attacks:[{name:'拍打',dmg:46,cost:1,type:'normal',rider:'type-draw',megaBoost:true,bonusEnergy:5},{name:'疾風吸能擊',dmg:65,cost:6,type:'flying',rider:'energy-steal'},{name:'妖精吸能擊',dmg:95,cost:11,type:'fairy',selfHeal:0.2,bonusVsType:'dark'},{name:'毒液',dmg:91,cost:11,type:'poison',ignoreReflect:true,status:{effect:'poison', chance:0.4},bonusVsType:'grass'}]},
  { mega:{spriteId:10279, type:'grass', type2:'poison', ability:{id:'tough-claws', name:'揭露之貌', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:71, name:'大食花', type:'grass', type2:'poison', hp:230, tier:1, ability:{id:'blaze-boost', name:'葉綠素', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'激流護甲擊',dmg:68,cost:5,type:'water',rider:'type-draw'},{name:'鐵頭',dmg:64,cost:5,type:'steel',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'葉刃',dmg:84,cost:10,type:'grass',megaBoost:true,bonusEnergy:7},{name:'惡意突刺',dmg:110,cost:15,type:'poison',status:{effect:'sleep', chance:0.4},bonusVsType:'rock',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10284, type:'steel', type2:'flying', ability:{id:'solid-rock', name:'頑強', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:227, name:'盔甲鳥', type:'steel', type2:'flying', hp:270, tier:2, ability:{id:'sturdy', name:'頑強', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}, attacks:[{name:'蟲刃剪',dmg:85,cost:10,type:'bug',rider:'mega-charge',megaBoost:true,bonusEnergy:8,ignoreReflect:true},{name:'鐵頭',dmg:92,cost:10,type:'steel',ignoreReflect:true,megaBoost:true,bonusEnergy:8},{name:'啄',dmg:110,cost:15,type:'flying',megaBoost:true,bonusEnergy:8,bonusVsType:'psychic'},{name:'破魂強奪擊',dmg:60,cost:5,type:'fighting',rider:'energy-steal'}]},
  { mega:{spriteId:10306, type:'psychic', type2:'steel', ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:358, name:'風鈴鈴', type:'psychic', hp:220, tier:1, ability:{id:'chance-debuff', name:'穿透', trigger:'onAttack', desc:'攻擊命中後 25% 機率讓對方下次攻擊傷害 ×0.9'}, attacks:[{name:'高周波音',dmg:55,cost:4,type:'normal',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'大地吸血擊',dmg:62,cost:4,type:'ground',rider:'mega-charge'},{name:'破魂威壓擊',dmg:86,cost:10,type:'fighting',megaBoost:true,bonusEnergy:6,rider:'self-cure'},{name:'念力',dmg:105,cost:15,type:'psychic',selfHeal:0.25,ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10311, type:'fire', type2:'steel', ability:{id:'blaze-boost', name:'熾熱核心', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:485, name:'席多藍恩', type:'fire', type2:'steel', hp:285, tier:3, ability:{id:'flash-fire', name:'引火', trigger:'onDefend', desc:'受到火屬性攻擊時完全免疫，下次攻擊威力 +20'}, attacks:[{name:'金屬爪',dmg:93,cost:12,type:'steel',megaBoost:true,bonusEnergy:5},{name:'大字爆炎',dmg:100,cost:12,type:'fire',ignoreReflect:true,selfHeal:0.18},{name:'毒針',dmg:73,cost:7,type:'poison',rider:'mega-charge',status:{effect:'poison', chance:0.4},status2:{effect:'burn',chance:0.4}},{name:'寶石爆破',dmg:41,cost:1,type:'rock',rider:'type-draw',status:{effect:'confusion', chance:0.4},status2:{effect:'poison',chance:0.4}}]},
  { mega:{spriteId:10312, type:'dark', type2:null, ability:{id:'tough-claws', name:'暗影', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:491, name:'達克萊伊', type:'dark', hp:310, tier:3, ability:{id:'tough-claws', name:'惡夢', trigger:'onAttack', desc:'攻擊傷害 +40'}, attacks:[{name:'泥巴射擊',dmg:85,cost:10,type:'ground',rider:'mega-charge',megaBoost:true,bonusEnergy:8},{name:'暗影球',dmg:68,cost:5,type:'ghost',rider:'energy-steal',megaBoost:true,bonusEnergy:7},{name:'夜騷動',dmg:110,cost:15,type:'dark',selfHeal:0.26,bonusVsType:'rock'},{name:'火焰牙',dmg:107,cost:15,type:'fire',ignoreReflect:true,status:{effect:'burn', chance:0.4},bonusVsType:'ice'}]},
  { mega:{spriteId:10286, type:'fire', type2:'fighting', ability:{id:'mold-breaker', name:'破格', trigger:'onAttack', desc:'攻擊時無視對方的防禦型特性'}}, id:500, name:'炎武王', type:'fire', type2:'fighting', hp:300, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'幽靈之爪',dmg:64,cost:4,type:'ghost',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'近身戰',dmg:83,cost:9,type:'fighting',ignoreReflect:true,megaBoost:true,bonusEnergy:5},{name:'荒草吸血擊',dmg:102,cost:14,type:'grass',selfHeal:0.28,bonusVsType:'water',ignoreReflect:true},{name:'火花',dmg:109,cost:14,type:'fire',selfHeal:0.29,bonusVsType:'psychic'}]},
  { mega:{spriteId:10287, type:'ground', type2:'steel', ability:{id:'tough-claws', name:'貫穿之鑽', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:530, name:'龍頭地鼠', type:'ground', type2:'steel', hp:300, tier:2, ability:{id:'blaze-boost', name:'沙之力', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'岩石滑落',dmg:58,cost:4,type:'rock',rider:'self-cure',megaBoost:true,bonusEnergy:7},{name:'泥巴射擊',dmg:77,cost:9,type:'ground',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'金屬爪',dmg:107,cost:14,type:'steel',selfHeal:0.18,bonusVsType:'bug',ignoreReflect:true},{name:'雪崩',dmg:103,cost:14,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'ground'}]},
  { mega:{spriteId:10288, type:'bug', type2:'poison', ability:{id:'sturdy', name:'硬殼盔甲', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}}, id:545, name:'蜈蚣王', type:'bug', type2:'poison', hp:260, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'冰凍光束',dmg:50,cost:3,type:'ice',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'逆鱗威壓擊',dmg:85,cost:9,type:'dragon',rider:'self-cure'},{name:'毒液',dmg:81,cost:9,type:'poison',megaBoost:true,bonusEnergy:6},{name:'連續啃咬',dmg:100,cost:14,type:'bug',ignoreReflect:true,status:{effect:'freeze', chance:0.4},bonusVsType:'dragon',ignoreShield:true}]},
  { mega:{spriteId:10289, type:'dark', type2:'fighting', ability:{id:'intimidate', name:'威嚇', trigger:'onEnter', desc:'上場時讓對方下一次攻擊傷害 ×0.9'}}, id:560, name:'頭巾混混', type:'dark', type2:'fighting', hp:240, tier:1, ability:{id:'status-immune-once', name:'淬鍊之心', trigger:'onStatus', desc:'首次被施加異常狀態時解除並免疫，之後攻擊傷害永久 +40'}, attacks:[{name:'灼熱吸能擊',dmg:77,cost:7,type:'fire',rider:'move-reflect',ignoreReflect:true},{name:'冰凍拳',dmg:73,cost:7,type:'ice',megaBoost:true,bonusEnergy:5,rider:'weaken'},{name:'近身戰',dmg:41,cost:1,type:'fighting',megaBoost:true,bonusEnergy:5,rider:'move-reflect'},{name:'惡意波動',dmg:99,cost:12,type:'dark',status:{effect:'freeze', chance:0.4},bonusVsType:'flying'}]},
  { mega:{spriteId:10290, type:'electric', type2:null, ability:{id:'motor-drive', name:'電鰻升格', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:604, name:'麻麻鰻魚王', type:'electric', hp:270, tier:2, ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'咬碎',dmg:91,cost:10,type:'dark',rider:'mega-charge',megaBoost:true,bonusEnergy:7,ignoreReflect:true},{name:'電磁炮',dmg:110,cost:15,type:'electric',megaBoost:true,bonusEnergy:8,bonusVsType:'water'},{name:'毒牙',dmg:83,cost:10,type:'poison',megaBoost:true,bonusEnergy:8,rider:'card-steal'},{name:'破魂護甲擊',dmg:66,cost:5,type:'fighting',rider:'self-cure'}]},
  { mega:{spriteId:10292, type:'grass', type2:'fighting', ability:{id:'solid-rock', name:'防彈', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:652, name:'布里卡隆', type:'grass', type2:'fighting', hp:300, tier:2, ability:{id:'blaze-boost', name:'茂盛', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'吼叫',dmg:64,cost:5,type:'normal',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'磚塊',dmg:84,cost:10,type:'fighting',rider:'mega-charge',megaBoost:true,bonusEnergy:6},{name:'藤鞭',dmg:110,cost:15,type:'grass',selfHeal:0.19,ignoreReflect:true},{name:'燕返',dmg:110,cost:15,type:'flying',selfHeal:0.16,bonusVsType:'fighting',ignoreReflect:true}]},
  { mega:{spriteId:10293, type:'fire', type2:'psychic', ability:{id:'motor-drive', name:'飄浮', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:655, name:'妖火紅狐', type:'fire', type2:'psychic', hp:260, tier:2, ability:{id:'blaze-boost', name:'猛火', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}, attacks:[{name:'毒針',dmg:78,cost:9,type:'poison',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'未來雷霆',dmg:85,cost:9,type:'psychic',megaBoost:true,bonusEnergy:6},{name:'暗影強奪擊',dmg:58,cost:4,type:'dark',rider:'mega-charge'},{name:'火花',dmg:100,cost:14,type:'fire',status:{effect:'confusion', chance:0.4},bonusVsType:'fairy',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10295, type:'fire', type2:'normal', ability:{id:'blaze-boost', name:'火鬃', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:668, name:'火炎獅', type:'fire', type2:'normal', hp:270, tier:2, ability:{id:'pressure', name:'緊張感', trigger:'onEnter', desc:'上場時讓對方損失 3 點能量'}, attacks:[{name:'突擊',dmg:87,cost:10,type:'normal',rider:'move-reflect',megaBoost:true,bonusEnergy:8},{name:'破魂吸血擊',dmg:83,cost:10,type:'fighting',ignoreReflect:true,rider:'life-drain'},{name:'大字爆炎',dmg:110,cost:15,type:'fire',megaBoost:true,bonusEnergy:8,bonusVsType:'ice'},{name:'惡意波動',dmg:62,cost:5,type:'dark',selfHeal:0.24,rider:'guard-up'}]},
  { mega:{spriteId:10296, type:'fairy', type2:null, ability:{id:'adaptability', name:'妖精領域', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:670, name:'花葉蒂', type:'fairy', hp:200, tier:1, ability:{id:'frisk-ward', name:'花之守護', trigger:'onDefend', desc:'25% 機率將受到的傷害 ×0.9'}, attacks:[{name:'日光束',dmg:53,cost:2,type:'grass',rider:'self-cure',megaBoost:true,bonusEnergy:4},{name:'雷光威壓擊',dmg:49,cost:2,type:'electric',ignoreReflect:true,rider:'weaken'},{name:'突擊',dmg:69,cost:7,type:'normal',megaBoost:true,bonusEnergy:4,rider:'mega-charge'},{name:'魔法閃耀',dmg:99,cost:12,type:'fairy',status:{effect:'freeze', chance:0.4},bonusVsType:'rock'}]},
  { mega:{spriteId:10314, type:'psychic', type2:null, ability:{id:'trace', name:'複製', trigger:'onEnter', desc:'上場時複製對手當前的特性'}}, id:678, name:'超能妙喵', type:'psychic', hp:220, tier:1, ability:{id:'chance-debuff', name:'穿透', trigger:'onAttack', desc:'攻擊命中後 25% 機率讓對方下次攻擊傷害 ×0.9'}, attacks:[{name:'暗黑爆破',dmg:52,cost:3,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:6},{name:'大地吸能擊',dmg:59,cost:3,type:'ground',rider:'self-cure'},{name:'火花',dmg:83,cost:9,type:'fire',megaBoost:true,bonusEnergy:7},{name:'念力',dmg:102,cost:14,type:'psychic',status:{effect:'sleep', chance:0.4},bonusVsType:'psychic',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10297, type:'dark', type2:'psychic', ability:{id:'huge-power', name:'唱反調', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:687, name:'烏賊王', type:'dark', type2:'psychic', hp:260, tier:2, ability:{id:'shield-invert', name:'顛倒之心', trigger:'onDefend', desc:'對手的防禦加成效果對自己反而變成傷害加成'}, attacks:[{name:'大地波動',dmg:59,cost:3,type:'ground',ignoreReflect:true,megaBoost:true,bonusEnergy:6,rider:'type-draw'},{name:'精神強擊',dmg:78,cost:8,type:'psychic',megaBoost:true,bonusEnergy:6,rider:'energy-steal'},{name:'神速護甲擊',dmg:74,cost:8,type:'normal',rider:'type-draw'},{name:'惡意波動',dmg:105,cost:13,type:'dark',selfHeal:0.21,bonusVsType:'rock'}]},
  { mega:{spriteId:10298, type:'rock', type2:'fighting', ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:689, name:'龜足巨鎧', type:'rock', type2:'water', hp:260, tier:2, ability:{id:'tough-claws', name:'硬爪', trigger:'onAttack', desc:'攻擊傷害 +40'}, attacks:[{name:'妖精吸能擊',dmg:80,cost:9,type:'fairy',rider:'mega-charge',megaBoost:true,bonusEnergy:6},{name:'鋼影強奪擊',dmg:64,cost:4,type:'steel',rider:'type-draw'},{name:'衝浪',dmg:83,cost:9,type:'water',megaBoost:true,bonusEnergy:6},{name:'岩石滑落',dmg:102,cost:14,type:'rock',ignoreReflect:true,selfHeal:0.21,bonusVsType:'fighting',ignoreShield:true}]},
  { mega:{spriteId:10299, type:'poison', type2:'dragon', ability:{id:'thick-fat', name:'再生力', trigger:'onDefend', desc:'受到火／冰屬性攻擊傷害 ×0.92'}}, id:691, name:'毒藻龍', type:'poison', type2:'dragon', hp:260, tier:2, ability:{id:'poison-point', name:'毒刺', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'十字剪',dmg:84,cost:9,type:'bug',rider:'type-draw',megaBoost:true,bonusEnergy:7},{name:'破魂吸血擊',dmg:57,cost:4,type:'fighting',rider:'energy-steal'},{name:'逆鱗護甲擊',dmg:87,cost:9,type:'dragon',megaBoost:true,bonusEnergy:7},{name:'惡意突刺',dmg:106,cost:14,type:'poison',ignoreReflect:true,selfHeal:0.15,bonusVsType:'grass',ignoreShield:true}]},
  { mega:{spriteId:10300, type:'fighting', type2:'flying', ability:{id:'huge-power', name:'無防守', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:701, name:'摔角鷹人', type:'fighting', type2:'flying', hp:230, tier:1, ability:{id:'desperate-blade', name:'輕盈', trigger:'onAttack', desc:'HP 低於 50% 時，攻擊傷害 +40'}, attacks:[{name:'惡意突刺',dmg:63,cost:5,type:'poison',rider:'mega-charge',megaBoost:true,bonusEnergy:8},{name:'大地威壓擊',dmg:59,cost:5,type:'ground',rider:'energy-steal'},{name:'疾風吸能擊',dmg:90,cost:10,type:'flying',megaBoost:true,bonusEnergy:8},{name:'空手劈',dmg:109,cost:15,type:'fighting',status:{effect:'poison', chance:0.4},bonusVsType:'fairy',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10301, type:'dragon', type2:'ground', ability:{id:'solid-rock', name:'極巨腺體', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}}, id:718, name:'基格爾德', type:'dragon', type2:'ground', hp:320, tier:3, ability:{id:'solid-rock', name:'終結之地', trigger:'onDefend', desc:'受到剋制（×1.2以上）的攻擊傷害再減少 5%'}, attacks:[{name:'咬碎',dmg:78,cost:8,type:'dark',rider:'energy-steal',megaBoost:true,bonusEnergy:8},{name:'電球',dmg:98,cost:13,type:'electric',status:{effect:'burn', chance:0.4},bonusVsType:'steel'},{name:'大地虹吸',dmg:105,cost:13,type:'ground',status:{effect:'paralysis', chance:0.4},bonusVsType:'flying',ignoreReflect:true},{name:'龍之波動',dmg:101,cost:13,type:'dragon',rider:'type-draw',selfHeal:0.21}]},
  { mega:{spriteId:10315, type:'fighting', type2:'ice', ability:{id:'tough-claws', name:'鐵拳', trigger:'onAttack', desc:'攻擊傷害 +40'}}, id:740, name:'好勝毛蟹', type:'fighting', type2:'ice', hp:270, tier:2, ability:{id:'true-damage', name:'不動如山', trigger:'onAttack', desc:'攻擊傷害不會被對方的防禦特性、閃避或撐住效果影響'}, attacks:[{name:'岩崩吸能擊',dmg:88,cost:10,type:'rock',rider:'move-reflect',ignoreReflect:true},{name:'決勝衝擊',dmg:107,cost:15,type:'fighting',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'冰凍拳',dmg:91,cost:10,type:'ice',megaBoost:true,bonusEnergy:7,rider:'move-reflect'},{name:'夜襲',dmg:63,cost:5,type:'dark',selfHeal:0.29,rider:'guard-up'}]},
  { mega:{spriteId:10302, type:'normal', type2:'dragon', ability:{id:'guts', name:'崩潰', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:780, name:'老翁龍', type:'normal', type2:'dragon', hp:300, tier:2, ability:{id:'guts', name:'崩潰', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'月亮力量',dmg:86,cost:9,type:'fairy',rider:'self-cure',megaBoost:true,bonusEnergy:6},{name:'龍之氣息',dmg:59,cost:4,type:'dragon',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'精神護甲擊',dmg:101,cost:14,type:'psychic',status:{effect:'confusion', chance:0.4},bonusVsType:'fighting',ignoreReflect:true},{name:'吼叫',dmg:108,cost:14,type:'normal',selfHeal:0.28,bonusVsType:'dark'}]},
  { mega:{spriteId:10317, type:'steel', type2:'fairy', ability:{id:'huge-power', name:'心之力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:801, name:'瑪機雅娜', type:'steel', type2:'fairy', hp:310, tier:3, ability:{id:'huge-power', name:'心之力', trigger:'onAttack', desc:'攻擊傷害固定 +40'}, attacks:[{name:'污泥炸彈',dmg:84,cost:9,type:'poison',ignoreReflect:true,megaBoost:true,bonusEnergy:8},{name:'魔法閃耀',dmg:57,cost:4,type:'fairy',rider:'energy-steal',megaBoost:true,bonusEnergy:8},{name:'鐵頭',dmg:110,cost:14,type:'steel',selfHeal:0.16,bonusVsType:'grass'},{name:'爆炸火焰',dmg:106,cost:14,type:'fire',selfHeal:0.18,bonusVsType:'bug',ignoreReflect:true}]},
  { mega:{spriteId:10319, type:'electric', type2:null, ability:{id:'motor-drive', name:'蓄電', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}}, id:807, name:'捷拉奧拉', type:'electric', hp:310, tier:3, ability:{id:'motor-drive', name:'蓄電', trigger:'onDefend', desc:'受到電屬性攻擊時完全免疫，並回復 3 點能量'}, attacks:[{name:'幽靈球',dmg:90,cost:10,type:'ghost',ignoreReflect:true,megaBoost:true,bonusEnergy:7},{name:'磚塊',dmg:62,cost:5,type:'fighting',rider:'mega-charge',megaBoost:true,bonusEnergy:8},{name:'冰霜吸血擊',dmg:105,cost:15,type:'ice',status:{effect:'freeze', chance:0.4},bonusVsType:'ground',ignoreReflect:true},{name:'雷霆',dmg:110,cost:15,type:'electric',selfHeal:0.24,bonusVsType:'ghost'}]},
  { mega:{spriteId:10303, type:'fighting', type2:null, ability:{id:'guts', name:'不服輸', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:870, name:'列陣兵', type:'fighting', hp:230, tier:1, ability:{id:'sturdy', name:'戰鬥盔甲', trigger:'onDefend', desc:'HP 全滿時，受到會直接擊倒的攻擊會保留 1 HP'}, attacks:[{name:'妖精之風',dmg:60,cost:5,type:'fairy',rider:'self-cure',megaBoost:true,bonusEnergy:8},{name:'精神護甲擊',dmg:67,cost:5,type:'psychic',ignoreReflect:true,rider:'guard-up'},{name:'大地威壓擊',dmg:87,cost:10,type:'ground',megaBoost:true,bonusEnergy:8,rider:'energy-steal'},{name:'岩石碎裂',dmg:106,cost:15,type:'fighting',selfHeal:0.18,bonusVsType:'dark'}]},
  { mega:{spriteId:10320, type:'grass', type2:'fire', ability:{id:'blaze-boost', name:'辣椒噴霧', trigger:'onAttack', desc:'HP 低於 1/3 時，本系招式傷害 ×1.1'}}, id:952, name:'狠辣椒', type:'grass', type2:'fire', hp:220, tier:1, ability:{id:'insomnia', name:'不眠', trigger:'onDefend', desc:'不會陷入睡眠狀態'}, attacks:[{name:'電擊',dmg:59,cost:5,type:'electric',ignoreReflect:true,megaBoost:true,bonusEnergy:6},{name:'神速強奪擊',dmg:66,cost:5,type:'normal',rider:'mega-charge'},{name:'噴射火焰',dmg:86,cost:10,type:'fire',megaBoost:true,bonusEnergy:6},{name:'能量球',dmg:105,cost:15,type:'grass',status:{effect:'paralysis', chance:0.4},bonusVsType:'water',ignoreReflect:true,ignoreShield:true}]},
  { mega:{spriteId:10321, type:'rock', type2:'poison', ability:{id:'adaptability', name:'適應力', trigger:'onAttack', desc:'屬性加成（STAB）提升為 ×1.2（原本 ×1.1）'}}, id:970, name:'晶光花', type:'rock', type2:'poison', hp:260, tier:2, ability:{id:'poison-point', name:'毒素碎片', trigger:'onDefend', desc:'受到攻擊後 20% 機率讓攻擊者中毒'}, attacks:[{name:'冰霜吸血擊',dmg:58,cost:4,type:'ice',rider:'self-cure',megaBoost:true,bonusEnergy:5,bonusVsType:'flying'},{name:'污泥炸彈',dmg:82,cost:10,type:'poison',megaBoost:true,bonusEnergy:5,rider:'card-steal'},{name:'幽冥吸血擊',dmg:89,cost:10,type:'ghost',rider:'mega-charge'},{name:'岩石滑落',dmg:108,cost:15,type:'rock',status:{effect:'freeze', chance:0.4},bonusVsType:'ground'}]},
  { mega:{spriteId:10322, type:'dragon', type2:'water', ability:{id:'huge-power', name:'指揮', trigger:'onAttack', desc:'攻擊傷害固定 +40'}}, id:978, name:'米立龍', type:'dragon', type2:'water', hp:210, tier:1, ability:{id:'legacy-boost', name:'指揮', trigger:'onLeave', desc:'陣亡或被換下場時，下一隻上場的我方寶可夢首次攻擊：能量消耗×0.5、傷害+40'}, attacks:[{name:'雪崩',dmg:53,cost:2,type:'ice',rider:'energy-steal',megaBoost:true,bonusEnergy:5},{name:'龍之脈動',dmg:49,cost:2,type:'dragon',rider:'self-cure',megaBoost:true,bonusEnergy:5},{name:'劇毒威壓擊',dmg:69,cost:7,type:'poison',rider:'weaken'},{name:'水槍',dmg:99,cost:12,type:'water',status:{effect:'freeze', chance:0.4},bonusVsType:'ground',ignoreReflect:true}]},
  { mega:{spriteId:10325, type:'dragon', type2:'ice', ability:{id:'guts', name:'熱交換', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}}, id:998, name:'戟脊龍', type:'dragon', type2:'ice', hp:245, tier:3, ability:{id:'guts', name:'熱交換', trigger:'onAttack', desc:'自身帶有異常狀態時，攻擊傷害 +40'}, attacks:[{name:'寶石爆破',dmg:45,cost:1,type:'rock',status:{effect:'freeze', chance:0.4},megaBoost:true,bonusEnergy:6,rider:'weaken'},{name:'龍之波動',dmg:69,cost:7,type:'dragon',rider:'self-cure',status:{effect:'confusion', chance:0.4},status2:{effect:'sleep',chance:0.4}},{name:'冰耳光',dmg:99,cost:12,type:'ice',selfHeal:0.23,bonusVsType:'bug'},{name:'蟲毒吸能擊',dmg:72,cost:7,type:'bug',selfHeal:0.17,rider:'weaken'}]},
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
  // ── stadium ──
  {id:'stadium-training',      name:'訓練場',     cat:'stadium', desc:'場上所有技能威力 +25（雙方）'},
  {id:'stadium-spring',        name:'地熱溫泉',   cat:'stadium', desc:'每回合結束，雙方上場寶可夢各回復 30 HP'},
  {id:'stadium-reversal',      name:'逆轉鬥技場', cat:'stadium', desc:'HP 低於 50% 時，攻擊威力 +30'},
  {id:'stadium-invert',        name:'反轉世界',   cat:'stadium', desc:'場上屬性相剋完全反轉（克制↔抵抗，免疫→克制×1.2）；反轉後仍是克制的攻擊，額外 +25 固定傷害'},
  {id:'stadium-dragon-valley', name:'龍之谷',     cat:'stadium', type:'dragon', weight:10, desc:'龍屬性寶可夢對妖精、冰系招式不受克制（效果最多×1）；龍屬性攻擊不會被減免或無效，且額外 +35 固定傷害'},
  {id:'stadium-evil-forest',   name:'邪惡森林',   cat:'stadium', type:'grass', weight:10, desc:'原本克制草屬性的寶可夢（火／冰／飛行／毒／蟲），全部變成弱草屬性（草屬性攻擊 ×1.2）；每回合結束，草屬性上場寶可夢回復 70 HP'},
  {id:'stadium-mega-prism',    name:'Mega 稜鏡塔', cat:'stadium', desc:'雙方每個自己的回合開始時，獲得 16 點 Mega 能量；可 Mega 進化或已經 Mega 進化的寶可夢，受到的攻擊傷害 ×0.6'},
  {id:'stadium-spikes',        name:'尖峰陷阱',   cat:'stadium', desc:'寶可夢上場時，受到最大HP 25% 的傷害（雙方對等）'},
  {id:'stadium-toxic-field',   name:'劇毒領域',   cat:'stadium', type:'poison', weight:10, desc:'寶可夢上場時，陷入中毒（雙方對等）；此場地下中毒傷害 ×2；每回合結束，毒屬性上場寶可夢回復 70 HP，並有 50% 機率完全閃避攻擊（不疊加）'},
  {id:'stadium-colosseum',     name:'羅馬鬥技場', cat:'stadium', type:'fighting', weight:10, desc:'格鬥屬性招式傷害 ×1.2；格鬥屬性攻擊不再被幽靈屬性完全免疫；格鬥屬性攻擊會連續發動兩次，第二次傷害 ×0.5（若第一次就打倒對手，第二次改攻擊新上場的寶可夢）'},
  {id:'stadium-mystic-space',  name:'魔幻空間',   cat:'stadium', type:'psychic', weight:10, desc:'超能力屬性寶可夢受到的傷害 ×0.75；弱點消失（不受超效傷害影響）'},
  {id:'stadium-lava',          name:'熔岩火山',   cat:'stadium', type:'fire', weight:10, desc:'火屬性招式傷害 +30；水屬性招式傷害 ×0.65'},
  {id:'stadium-ocean',         name:'海洋世界',   cat:'stadium', type:'water', weight:10, desc:'水屬性招式消耗能量 ×0.3；電屬性招式傷害 ×1.4；水屬性寶可夢傷害額外 +40'},
  {id:'stadium-shrine',        name:'莊嚴神社',   cat:'stadium', type:'normal', weight:10, desc:'一般屬性招式一律視為剋制對手（效果拉滿 ×1.2）；一般屬性攻擊方命中後回復等同傷害量的HP；一般屬性寶可夢受到的攻擊傷害 -30'},
  // ── stadium：屬性分類新卡 ──
  {id:'stadium-sandstorm',   name:'沙塵暴',   cat:'stadium', type:'ground', weight:10, desc:'非地面／岩石／鋼屬性寶可夢，每回合結束損失最大HP的12%'},
  {id:'stadium-rock-field',  name:'岩石地帶', cat:'stadium', type:'rock', weight:10, desc:'岩石／地面／鋼屬性寶可夢，受到的攻擊傷害 -50，且不會再被剋制（弱點消除）'},
  // ── 競技場牌：8種先前沒有專屬場地的屬性（2026-07-23新增，各自搭配一個獨特玩法，不只是傷害數值）──
  {id:'stadium-electric-storm', name:'雷雲庇護所', cat:'stadium', type:'electric', weight:10, desc:'電屬性招式傷害 +30；每回合結束，雙方上場寶可夢若無異常狀態，20% 機率陷入麻痺'},
  {id:'stadium-ice-tundra',     name:'永凍冰原',   cat:'stadium', type:'ice',      weight:10, desc:'冰屬性招式傷害 +30；每回合結束，雙方上場寶可夢若無異常狀態，15% 機率陷入結凍'},
  {id:'stadium-dark-curse',     name:'暗夜詛咒領域', cat:'stadium', type:'dark',   weight:10, desc:'惡屬性招式傷害 ×1.2；此場地啟用中，雙方的所有恢復效果全部失效'},
  {id:'stadium-steel-fortress', name:'鋼鐵堡壘',   cat:'stadium', type:'steel',    weight:10, desc:'鋼屬性招式傷害 +30；此場地下，雙方受到的攻擊傷害固定減少 20'},
  {id:'stadium-flying-wind',    name:'疾風之翼',   cat:'stadium', type:'flying',   weight:10, desc:'飛行屬性招式傷害 ×1.2；飛行屬性寶可夢有 50% 機率完全閃避攻擊（不疊加）'},
  {id:'stadium-bug-hive',       name:'蟲群巢穴',   cat:'stadium', type:'bug',      weight:10, desc:'蟲屬性招式傷害 +30；此場地下，抽牌／搶奪對方手牌類卡片不受每回合1次限制'},
  {id:'stadium-ghost-curse',    name:'亡靈墓園',   cat:'stadium', type:'ghost',    weight:10, desc:'幽靈屬性招式傷害 ×1.2；此場地下，異常狀態無法被解除'},
  {id:'stadium-fairy-ward',     name:'妖精結界原野', cat:'stadium', type:'fairy',  weight:10, desc:'妖精屬性招式傷害 +30；此場地下，雙方招式的異常狀態附加機率降低 10%（下限0%）'},
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

/* ═══════════════════════════════════════════
   GAME LOGIC  (synchronous server-side)
═══════════════════════════════════════════ */
function clonePoke(p) {
  return { ...p, attacks: p.attacks.map(a => ({...a})), cur: p.hp, status: null,
    megaEvolved: p.mega ? false : undefined };
}

function effectiveCostSrv(atk, opponentPoke, G, buff, attackerPoke, opRole) {
  // 電光石火／全力以赴：2026-07-28應使用者要求，原本「這次攻擊必定免費」改成「攻擊的寶可夢
  // 或招式本身符合指定屬性才免費」——buff.costFreeType記著是哪個屬性（'electric'/'normal'）
  if (buff?.costFreeType && attackerPoke &&
      (attackerPoke.type === buff.costFreeType || attackerPoke.type2 === buff.costFreeType || atk.type === buff.costFreeType)) return 0;
  let cost = atk.cost;
  // 2026-07-31應使用者要求：mega進化後攻擊消耗的能量要比不能mega的寶可夢更低，固定8折
  if (attackerPoke?.megaEvolved) cost = Math.floor(cost * 0.8);
  if (G?.activeStadium?.id === 'stadium-ocean' && atk.type === 'water') cost = Math.floor(cost * 0.3);
  if (buff?.costHalved) cost = Math.floor(cost / 2);
  // 漩渦威壓（洛奇亞專屬）：只要牠在場上防守，對手攻擊消耗的能量持續 +3（封印特性時視為不存在）
  if (opponentPoke?.ability?.id === 'vortex-pressure' && opRole && !isAbilitySealedSrv(opRole, G)) cost += 3;
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
    // 2026-07-24應使用者要求「場地卡下修」，把m=4（compressMult=1.6）調回m=2（compressMult=1.2）
    if (GRASS_COUNTER_TYPES.includes(defType) || GRASS_COUNTER_TYPES.includes(defType2)) m = 2;
  }
  if (G?.activeStadium?.id === 'stadium-colosseum') {
    if (eAtk === 'fighting' && (defType === 'ghost' || defType2 === 'ghost') && m === 0) m = 1;
  }
  if (G?.activeStadium?.id === 'stadium-mystic-space') {
    if ((defType === 'psychic' || defType2 === 'psychic') && m > 1) m = 1;
  }
  // 岩石地帶：2026-07-27應使用者要求，除了減傷之外再加碼「弱點消除」——岩石／地面／鋼屬性
  // 寶可夢不會再被剋制，跟魔幻空間（psychic）同一套pattern
  if (G?.activeStadium?.id === 'stadium-rock-field') {
    if ((['rock','ground','steel'].includes(defType) || ['rock','ground','steel'].includes(defType2)) && m > 1) m = 1;
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
function handleStatus(poke, log, atkType) {
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
    if (Math.random() < 0.50) {
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
      const heal = Math.max(1, Math.floor(poke.hp / 8));
      poke.cur = Math.min(poke.hp, poke.cur + heal);
      log.push({ text: `${poke.name} 的毒療發動，中毒回復了 ${heal} HP！`, cls: 'special' });
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
function inflictStatus(poke, effect, turnsLeft) {
  // 治癒彩虹（鳳王專屬）：完全不會受到任何負面狀態——所有狀態賦予路徑最終都會呼叫這個共用函式
  if (poke.ability?.id === 'healing-rainbow') return false;
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
  const burnMult  = attacker.status?.type === 'burn' ? 0.94 : 1;
  // aRole/dRole moved up from further down (identity-comparison only, doesn't depend on anything
  // computed later) so the early-return immunity branches below can also respect 封印特性.
  const aRole = aBuff === G.p1Buff ? 'p1' : 'p2';
  const dRole = dBuff === G.p1Buff ? 'p1' : 'p2';
  // 封印特性卡生效中的那一側，特性視為不存在——後面整個function一律讀attackerAbility/defenderAbility
  // 這兩個local變數，不要直接讀attacker.ability/defender.ability（那樣會繞過封印判定）
  const attackerAbility = isAbilitySealedSrv(aRole, G) ? null : attacker.ability;
  const defenderAbility = isAbilitySealedSrv(dRole, G) ? null : defender.ability;

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
    const rawMult = compressMult(srvEff(atkType, attacker.type));
    const dmg     = Math.max(1, Math.floor((atk.dmg + aBuff.atkBonus) * aBuff.atkMult * burnMult * (rawMult || 1)));
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

  /* Flash Fire: full immunity to fire-type moves, boosts own next attack instead */
  if (defenderAbility?.id === 'flash-fire' && atkType === 'fire') {
    dBuff.atkBonus = 20;
    log.push({ text: `${attacker.name} 使用了 ${atk.name}！`, cls: 'attack' });
    log.push({ text: `${defender.name} 的引火吸收了攻擊，下次攻擊威力提升！`, cls: 'special' });
    aBuff.atkBonus = 0; aBuff.atkMult = 1; aBuff.typeOverride = null; aBuff.doubleStrike = false; aBuff.typeBoost = null; aBuff.ignoreShield = false; aBuff.guaranteedStatus = false; aBuff.costFreeType = null; aBuff.costHalved = false; aBuff.ignoreReflectNext = false; aBuff.iceHowlFreeze = false; dBuff.shield = 0; dBuff.iceImmune = false;
    return { damage: 0, mult: 1 };
  }

  let mult = srvEffActive(atkType, defender.type, defender.type2, G);
  // 破格系特性：既有的mold-breaker（Mega限定）+ true-damage（不動如山，攻擊無視對方防禦特性/閃避/撐住）共用同一個布林
  const moldBreaker = attackerAbility?.id === 'mold-breaker' || attackerAbility?.id === 'true-damage';
  // 深淵支配：不會受到超效傷害（型效乘數封頂在1，只降不升，不影響自己剋制對方時的正常效果）
  // （2026-08-04：伊裴爾塔爾專屬的no-weakness-dodge-60已改成dark-abyss-lockdown，效果完全不同，
  // 不再屬於這個閃避家族，這裡只剩暴鯉龍/化石翼龍/冰岩怪共用的10%版本）
  const isAbyssDodgeFamily = defenderAbility?.id === 'no-weakness-dodge';
  if (!moldBreaker && isAbyssDodgeFamily) mult = Math.min(mult, 1);
  // 屬性轉換 (type-orb) makes the overridden type count as own for STAB purposes — pure upside.
  const isOwnType = aBuff.typeOverride ? true : (atkType === attacker.type || (attacker.type2 && atkType === attacker.type2));
  const isAdaptability = isOwnType && attackerAbility?.id === 'adaptability';
  const stabMult = isOwnType ? (isAdaptability ? 1.2 : 1.1) : 1;
  // 2026-07-22應使用者要求「場地卡全面加強，成為對戰核心策略」，16張場地卡數值全面上調
  // 2026-07-24應使用者要求「場地卡太過強勢」，把傷害倍率壓回~1.2、固定加成>40的下修到30以下
  const stadiumBonus = G?.activeStadium?.id === 'stadium-training' ? 25 : 0;
  const reversalBonus = G?.activeStadium?.id === 'stadium-reversal' && attacker.cur <= attacker.hp * 0.5 ? 30 : 0;
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
  // 強子引擎(密勒頓)/緋紅脈動(故勒頓)：各自專屬id，沿用blaze-boost同樣的「HP<1/3本系傷害×1.1」判定
  const isBlazeBoostFamily = attackerAbility?.id === 'blaze-boost' || attackerAbility?.id === 'hadron-engine' || attackerAbility?.id === 'crimson-pulse';
  const abilityDmgMult = ((isBlazeBoostFamily && lowHpSelf && isOwnType) ? 1.1
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
  // 2026-07-31應使用者要求再調整為三段式：不能mega的寶可夢基礎傷害要更高、能mega但還沒
  // 進化的要更低、mega進化後要比不能mega的更高——維持同一套「固定加成」寫法，跟
  // pokemon_battle.html同步（見該檔案同一行的完整說明）
  const megaBoostBonus = !attacker.mega ? 40 : attacker.megaEvolved ? 100 : -20;
  // 使用者要求「傷害高的招式，遇到特定屬性可以加攻」：部分高消耗招式帶bonusVsType欄位，
  // 命中該屬性對手時額外+50固定傷害，跟pokemon_battle.html的doAttack同一套處理
  const bonusVsTypeBonus = (atk.bonusVsType && (defender.type === atk.bonusVsType || defender.type2 === atk.bonusVsType)) ? 50 : 0;
  const colosseumMult = (G.activeStadium?.id === 'stadium-colosseum' && atkType === 'fighting') ? 1.2 : 1;
  const mysticSpaceMult = (G.activeStadium?.id === 'stadium-mystic-space' && (defender.type === 'psychic' || defender.type2 === 'psychic')) ? 0.75 : 1;
  // Lava Volcano: fire-type moves固定加成；water-type moves ×0.65（削弱維持不變，2026-07-24只下修攻擊向的加成）
  const lavaBonus = (G.activeStadium?.id === 'stadium-lava' && atkType === 'fire') ? 30 : 0;
  const lavaMult = (G.activeStadium?.id === 'stadium-lava' && atkType === 'water') ? 0.65 : 1;
  // 2026-07-28應使用者要求從×1.2上修到×1.4
  const oceanMult = (G.activeStadium?.id === 'stadium-ocean' && atkType === 'electric') ? 1.4 : 1;
  // Ocean World：水屬性「寶可夢」固定+40傷害（不是招式屬性，是攻擊方自己的種族屬性）。
  // 2026-08-04修正：跟abilityDmgBonus的drizzle-ocean判定（水/冰招式+40）重疊，排除已算過ability加成的情況。
  const oceanAbilityAlreadyCounted = attackerAbility?.id === 'drizzle-ocean' && (atkType === 'water' || atkType === 'ice');
  const oceanPokeBonus = (G.activeStadium?.id === 'stadium-ocean' && (attacker.type === 'water' || attacker.type2 === 'water') && !oceanAbilityAlreadyCounted) ? 40 : 0;
  // 岩石地帶：岩石／地面／鋼屬性寶可夢，受到攻擊固定減傷50（2026-07-27應使用者要求「-150太多了」下修，
  // 從-150調回-50，並在srvEffActive()額外加碼「弱點消除」讓這張卡不只靠單一個數字撐強度）
  const rockFieldReduction = (G.activeStadium?.id === 'stadium-rock-field' &&
    (['rock','ground','steel'].includes(defender.type) || ['rock','ground','steel'].includes(defender.type2))) ? 50 : 0;
  // 莊嚴神社：一般屬性寶可夢受到攻擊固定減傷30，跟rockFieldReduction同一套寫法
  const shrineReduction = (G.activeStadium?.id === 'stadium-shrine' &&
    (defender.type === 'normal' || defender.type2 === 'normal')) ? 30 : 0;
  // 反轉世界：反轉後如果仍然是「克制」（mult>1），額外+25固定傷害
  const invertBonus = (G.activeStadium?.id === 'stadium-invert' && mult > 1) ? 25 : 0;
  // 2026-07-23新增8張場地卡的傷害加成部分（獨特玩法另外在別處實作）
  const electricStormBonus = (G.activeStadium?.id === 'stadium-electric-storm' && atkType === 'electric') ? 30 : 0;
  const iceTundraBonus = (G.activeStadium?.id === 'stadium-ice-tundra' && atkType === 'ice') ? 30 : 0;
  const steelFortressBonus = (G.activeStadium?.id === 'stadium-steel-fortress' && atkType === 'steel') ? 30 : 0;
  const bugHiveBonus = (G.activeStadium?.id === 'stadium-bug-hive' && atkType === 'bug') ? 30 : 0;
  const fairyWardBonus = (G.activeStadium?.id === 'stadium-fairy-ward' && atkType === 'fairy') ? 30 : 0;
  const darkCurseMult = (G.activeStadium?.id === 'stadium-dark-curse' && atkType === 'dark') ? 1.2 : 1;
  const flyingWindMult = (G.activeStadium?.id === 'stadium-flying-wind' && atkType === 'flying') ? 1.2 : 1;
  const ghostCurseMult = (G.activeStadium?.id === 'stadium-ghost-curse' && atkType === 'ghost') ? 1.2 : 1;
  const steelFortressReduction = G.activeStadium?.id === 'stadium-steel-fortress' ? 20 : 0;
  // Mega稜鏡塔：可Mega進化或已經Mega進化的寶可夢受到攻擊×0.6，跟pokemon_battle.html的doAttack同一套處理
  const megaPrismMult = (G.activeStadium?.id === 'stadium-mega-prism' && (defender.mega || defender.megaEvolved)) ? 0.6 : 1;
  const stadiumMult = colosseumMult * mysticSpaceMult * lavaMult * oceanMult * darkCurseMult * flyingWindMult * ghostCurseMult * megaPrismMult;
  const stadiumFlatBonus = stadiumBonus + reversalBonus + lavaBonus + dragonValleyBonus + invertBonus +
    electricStormBonus + iceTundraBonus + steelFortressBonus + bugHiveBonus + fairyWardBonus + oceanPokeBonus;
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
    // 2026-07-31新增atk.ignoreShield：部分高消耗招式自帶「無視盾牌」（跟既有的buff版
    // aBuff.ignoreShield／直搗黃龍卡片並存，任一個成立就無視）
    const shieldTerm = (aBuff.ignoreShield || atk.ignoreShield) ? 0 : (defenderAbility?.id === 'shield-invert' ? -dBuff.shield : dBuff.shield);
    // 2026-07-30應使用者回報「傷害計算怪怪的」修正：固定減傷（shieldTerm/rockFieldReduction/
    // steelFortressReduction）疊加起來可能超過乘法鏈算出來的傷害本身，原本扣減後沒有再夾在0以上，
    // 會讓damage變成負數，等同攻擊反而幫defender加血。外層包Math.max(0,...)避免倒扣出負傷害。
    // 2026-08-04修正：羅馬鬥技場第二段攻擊的×0.5要乘在整條乘法鏈最後面（atk._halfDamage），
    // 不能只砍atk.dmg這個小加項——megaBoostBonus/abilityDmgBonus等固定加成完全不會被砍到，
    // 導致第二段幾乎跟第一段一樣高（使用者回報「兩下攻擊都超過300」）。
    damage = Math.max(0, Math.max(1, Math.floor((atk.dmg + aBuff.atkBonus + stadiumFlatBonus + legacyDmgBonus + abilityDmgBonus + megaBoostBonus + typeBoostBonus + bonusVsTypeBonus) * effectiveAtkMult * burnMult * mult * stabMult * switchGuardMult * standbyGuardMult * abilityDmgMult * defAbilityMult * stadiumMult * typeBoostMult * reflectPierceMult * (atk._halfDamage ? 0.5 : 1))) - shieldTerm - rockFieldReduction - steelFortressReduction - shrineReduction);
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
    // 疾風之翼／劇毒領域：場地生效中，飛行／毒屬性寶可夢有50%機率完全閃避攻擊，跟pokemon_battle.html
    // 的doAttack同一套「dmg>0才骰、true-damage無視、不疊加其他閃避來源」寫法
    const stadiumDodgeActive =
      (G.activeStadium?.id === 'stadium-flying-wind' && (defender.type === 'flying' || defender.type2 === 'flying')) ||
      (G.activeStadium?.id === 'stadium-toxic-field' && (defender.type === 'poison' || defender.type2 === 'poison'));
    if (!moldBreaker && damage > 0 && stadiumDodgeActive && Math.random() < 0.5) {
      damage = 0;
      log.push({ text: `${defender.name} 靠著【${G.activeStadium.name}】完全閃避了攻擊！`, cls: 'special' });
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
    if (isBlazeBoostFamily && lowHpSelf && isOwnType) log.push({ text: `${attacker.name} 瀕危爆發，本系招式威力大幅提升！`, cls: 'super' });
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
    if (damage > 0 && atk.selfHeal && attacker.cur > 0 && !isHealSealedSrv(aRole, G)) {
      const heal = Math.round((attacker.hp - attacker.cur) * atk.selfHeal);
      if (heal > 0) {
        attacker.cur = Math.min(attacker.hp, attacker.cur + heal);
        log.push({ text: `${attacker.name} 靠著攻擊回復了 ${heal} HP！`, cls: 'special' });
      }
    }
    // 莊嚴神社：一般屬性攻擊方命中後，回復等同這次傷害量的HP，跟pokemon_battle.html的doAttack同一套處理
    if (damage > 0 && (attacker.type === 'normal' || attacker.type2 === 'normal') && G.activeStadium?.id === 'stadium-shrine' && attacker.cur > 0 && !isHealSealedSrv(aRole, G)) {
      const shrineHeal = Math.min(damage, attacker.hp - attacker.cur);
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
    if (damage > 0) triggerAttackerAbilitySrv(attacker, defender, log, dBuff, G);
    if (damage > 0) triggerDefenderAbilitySrv(defender, attacker, log, dBuff, G);
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
      // 鎂光反射：2026-07-28新增，defender若架有反射負面效果的護盾，這次異常狀態改套用到
      // attacker自己身上，護盾消耗掉（不再檢查defender的own-tempo/insomnia等免疫）
      if (dBuff.debuffReflect) {
        dBuff.debuffReflect = false;
        if (attacker.cur > 0) {
          const reflectTurns = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                              : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                              : effect === 'freeze'    ? 2
                              : 999;
          if (inflictStatus(attacker, effect, reflectTurns)) {
            log.push({ text: `${defender.name} 的鎂光反射將異常狀態彈了回去，${attacker.name} 陷入了${STATUS_ZH[effect]}！`, cls: 'special' });
          } else {
            log.push({ text: `${defender.name} 的鎂光反射彈開了異常狀態！`, cls: 'special' });
          }
        } else {
          log.push({ text: `${defender.name} 的鎂光反射彈開了異常狀態！`, cls: 'special' });
        }
      } else if (effect === 'confusion' && defenderAbility?.id === 'own-tempo') {
        log.push({ text: `${defender.name} 的我行我素抵消了混亂！`, cls: 'special' });
      } else if (effect === 'sleep' && defenderAbility?.id === 'insomnia') {
        log.push({ text: `${defender.name} 的不眠抵消了睡眠！`, cls: 'special' });
      } else {
        const turnsLeft = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                        : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                        : effect === 'freeze'    ? 2
                        : 999;
        if (!inflictStatus(defender, effect, turnsLeft)) {
          log.push({ text: `${defender.name} 異常狀態已達上限，沒有生效。`, cls: 'system' });
          return;
        }
        log.push({ text: `${defender.name} 陷入了${STATUS_ZH[effect]}！`, cls: 'special' });
        if (['poison','burn','paralysis'].includes(effect) && defenderAbility?.id === 'sync-status' && attacker.cur > 0 && inflictStatus(attacker, effect, 999)) {
          log.push({ text: `${defender.name} 的同步將${STATUS_ZH[effect]}傳染給了${attacker.name}！`, cls: 'special' });
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
      if (attacker.cur > 0 && inflictStatus(attacker, 'freeze', 2)) {
        log.push({ text: `${defender.name} 的鎂光反射將異常狀態彈了回去，${attacker.name} 陷入了結凍！`, cls: 'special' });
      } else {
        log.push({ text: `${defender.name} 的鎂光反射彈開了異常狀態！`, cls: 'special' });
      }
    } else if (inflictStatus(defender, 'freeze', 2)) {
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
        if (effect === 'confusion' && defender.ability?.id === 'own-tempo') {
          log.push({ text: `${defender.name} 的我行我素抵消了混亂！`, cls: 'special' });
        } else if (effect === 'sleep' && defender.ability?.id === 'insomnia') {
          log.push({ text: `${defender.name} 的不眠抵消了睡眠！`, cls: 'special' });
        } else {
          const turnsLeft = effect === 'sleep' ? (Math.floor(Math.random()*2)+2)
                          : effect === 'confusion' ? (Math.floor(Math.random()*3)+2)
                          : effect === 'freeze'    ? 2
                          : 999;
          if (inflictStatus(defender, effect, turnsLeft)) {
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
    const dmg = Math.max(1, Math.round(poke.hp * 0.25));
    poke.cur = Math.max(0, poke.cur - dmg); // 扣血效果應該能讓寶可夢陣亡，不該保留1HP
    log.push({ text: `${poke.name} 受到了尖峰陷阱的傷害！（-${dmg} HP）`, cls: 'special' });
  }
  if (G.activeStadium?.id === 'stadium-toxic-field' && inflictStatus(poke, 'poison', 999)) {
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
const MEGA_MOVESET_COSTS = [4, 6, 9, 12];
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
  if (attacker.ability.id === 'static-trail' && defender.cur > 0 && Math.random() < 0.15 && inflictStatus(defender, 'paralysis', 999)) {
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
  if (defender.ability.id === 'static' && Math.random() < 0.20 && inflictStatus(attacker, 'paralysis', 999)) {
    log.push({ text: `${defender.name} 的靜電讓 ${attacker.name} 陷入了麻痺！`, cls: 'special' });
  } else if (defender.ability.id === 'rough-skin') {
    const recoil = Math.max(1, Math.floor(attacker.hp / 8));
    attacker.cur = Math.max(0, attacker.cur - recoil);
    log.push({ text: `${defender.name} 的粗糙皮膚反彈了 ${recoil} 點傷害給 ${attacker.name}！`, cls: 'special' });
  } else if (defender.ability.id === 'poison-point' && Math.random() < 0.20 && inflictStatus(attacker, 'poison', 999)) {
    log.push({ text: `${defender.name} 的毒刺讓 ${attacker.name} 陷入了中毒！`, cls: 'special' });
  } else if (defender.ability.id === 'flame-body' && Math.random() < 0.20 && inflictStatus(attacker, 'burn', 999)) {
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
    case 'antidote':
      if (G.activeStadium?.id === 'stadium-ghost-curse') {
        log.push({ text: `異常狀態被亡靈墓園封印，無法解除！`, cls: 'system' });
      } else if (active.status || active.status2) {
        const cured = [active.status, active.status2].filter(Boolean).map(st => STATUS_ZH[st.type] || st.type);
        active.status = null;
        active.status2 = null;
        log.push({ text: `萬能藥解除了 ${active.name} 的${cured.join('、')}！`, cls: 'system' });
      }
      break;
    case 'nurse': {
      const ghostCursed = G.activeStadium?.id === 'stadium-ghost-curse';
      if (isHealSealedSrv(role, G)) {
        if (!ghostCursed) { active.status = null; active.status2 = null; }
        log.push({ text: ghostCursed ? `異常狀態被亡靈墓園封印，恢復效果也被詛咒封印！` : `治療師解除了 ${active.name} 的異常狀態，但恢復效果被詛咒封印中，HP 沒有回復！`, cls: 'system' });
      } else {
        active.cur = active.hp;
        if (!ghostCursed) { active.status = null; active.status2 = null; }
        log.push({ text: `治療師讓 ${active.name} 完全回復${ghostCursed ? 'HP，但異常狀態被亡靈墓園封印，無法解除' : ''}！`, cls: 'system' });
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
      if (inflictStatus(opActive, 'burn', 999)) { log.push({ text: `火焰彈讓 ${opActive.name} 陷入燒傷！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，火焰彈無效！`, cls: 'system' });
      break;
    }
    case 'gas-attack': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (inflictStatus(opActive, 'poison', 999)) { log.push({ text: `瓦斯攻擊讓 ${opActive.name} 陷入中毒！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，瓦斯攻擊無效！`, cls: 'system' });
      break;
    }
    case 'confuse-potion': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (opActive.ability?.id === 'own-tempo') { log.push({ text: `${opActive.name} 的我行我素抵消了混亂藥！`, cls: 'system' }); }
      else if (inflictStatus(opActive, 'confusion', Math.floor(Math.random()*3)+2)) { log.push({ text: `混亂藥讓 ${opActive.name} 陷入混亂！`, cls: 'special' }); }
      else log.push({ text: `${opActive.name} 異常狀態已達上限，混亂藥無效！`, cls: 'system' });
      break;
    }
    case 'absolute-zero': {
      const opDeck = G[`${op}Deck`]; const opActive = opDeck[G[`${op}Idx`]];
      if (inflictStatus(opActive, 'freeze', 2)) { log.push({ text: `絕對零度讓 ${opActive.name} 陷入結凍！`, cls: 'special' }); }
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
      if (inflictStatus(opActive, 'paralysis', 999)) { log.push({ text: `電擊誘餌讓 ${opActive.name} 陷入麻痺！`, cls: 'special' }); }
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
      if (inflictStatus(opActive, 'poison', 999)) { log.push({ text: `群聚針刺讓 ${opActive.name} 陷入中毒，並損失了 ${before - G[`${op}Energy`]} 點能量！`, cls: 'special' }); }
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
      if (Math.random() < 0.3 && inflictStatus(opActive, 'burn', 999)) {
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
      } else if (inflictStatus(opActive, 'sleep', 1)) {
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
      if (inflictStatus(opActive, 'poison', 999)) {
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
      if (!isFireMon && inflictStatus(active, 'burn', 999)) {
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
      if (Math.random() < 0.4 && inflictStatus(opActive, 'paralysis', 999)) {
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
      } else if (Math.random() < 0.3 && inflictStatus(opActive, 'confusion', Math.floor(Math.random() * 3) + 2)) {
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
      if (Math.random() < 0.5 && inflictStatus(opActive, 'poison', 999)) {
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
    case 'stadium-rock-field':
    case 'stadium-electric-storm':
    case 'stadium-ice-tundra':
    case 'stadium-dark-curse':
    case 'stadium-steel-fortress':
    case 'stadium-flying-wind':
    case 'stadium-bug-hive':
    case 'stadium-ghost-curse':
    case 'stadium-fairy-ward': {
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
  G[`${role}UsedItemThisTurn`] = false; // 機械之心系特性的旗標，每回合開始重置
  G[`${role}StadiumTradeCount`] = 0; // 棄1張換競技場卡的每回合上限，這裡是該角色回合真正開始的地方
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
  // 雷雲庇護所／永凍冰原：每回合結束，雙方若無異常狀態，一定機率陷入麻痺／結凍
  if (G.activeStadium?.id === 'stadium-electric-storm') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur > 0 && Math.random() < 0.2) inflictStatus(poke, 'paralysis', 999);
    }
  }
  if (G.activeStadium?.id === 'stadium-ice-tundra') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur > 0 && Math.random() < 0.15) inflictStatus(poke, 'freeze', 2);
    }
  }
  // 邪惡森林：每回合結束，草屬性上場寶可夢回復70HP，跟stadium-spring同一套寫法
  if (G.activeStadium?.id === 'stadium-evil-forest') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur > 0 && poke.cur < poke.hp && (poke.type === 'grass' || poke.type2 === 'grass') && !isHealSealedSrv(r, G)) {
        poke.cur = Math.min(poke.hp, poke.cur + 70);
      }
    }
  }
  // 劇毒領域：每回合結束，毒屬性上場寶可夢回復70HP，跟stadium-evil-forest同一套寫法
  if (G.activeStadium?.id === 'stadium-toxic-field') {
    for (const r of ['p1', 'p2']) {
      const poke = G[`${r}Deck`][G[`${r}Idx`]];
      if (poke.cur > 0 && poke.cur < poke.hp && (poke.type === 'poison' || poke.type2 === 'poison') && !isHealSealedSrv(r, G)) {
        poke.cur = Math.min(poke.hp, poke.cur + 70);
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
  // 灰燼決意：上回合使用時承諾的「下回合損失能量」，這裡兌現後歸零（promote-then-consume）
  if (G[`${role}EnergyLossNextTurn`]) {
    G[`${role}Energy`] = Math.max(0, (G[`${role}Energy`] || 0) - G[`${role}EnergyLossNextTurn`]);
    G[`${role}EnergyLossNextTurn`] = 0;
  }
  if (G.activeStadium?.id === 'stadium-mega-prism' && !G[`${role}MegaUsed`]) {
    G[`${role}MegaEnergy`] = Math.min(20, (G[`${role}MegaEnergy`] || 0) + 16);
  }
  const op = role === 'p1' ? 'p2' : 'p1';
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
const POCKET_CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'pocket-cards.json'), 'utf8')).cards;
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
    status: null, // null | 'asleep' | 'poisoned' | 'paralyzed'
    cantAttackUntilTurn: 0, // === G.turnNumber 時這回合不能攻擊（用turnNumber比對，過了自然失效不用額外清）
    cantRetreatUntilTurn: 0,
    dmgDebuffUntilTurn: 0,
    dmgDebuffAmount: 0,
    isFossil: false,
  };
}
// 化石道具卡（Helix/Dome/Old Amber）：文字是「當作40HP無色基礎寶可夢上場」，
// 上場時把Trainer卡臨時轉成一張虛擬的寶可夢卡放進board，不進TRAINER_EFFECTS的一般道具流程
const POCKET_FOSSIL_IDS = new Set(['A1-216', 'A1-217', 'A1-218']);
function makePocketFossilInstance(cardId) {
  const base = POCKET_CARDS_BY_ID[cardId];
  return {
    id: base.id, name: base.name, category: 'Pokemon', image: base.image, ex: false,
    types: ['Colorless'], hp: 40, stage: 'Basic', evolveFrom: null, attacks: [], abilities: null,
    weaknesses: null, retreat: null, // retreat:null → 之後檢查撤退時視為「不能撤退」
    uid: `c${pocketUidCounter++}`, curHp: 40, energy: [], boardTurn: null,
    status: null, cantAttackUntilTurn: 0, cantRetreatUntilTurn: 0, dmgDebuffUntilTurn: 0, dmgDebuffAmount: 0,
    isFossil: true,
  };
}
function pocketIsPlayableAsBasic(handCard) {
  return (handCard.category === 'Pokemon' && handCard.stage === 'Basic') || POCKET_FOSSIL_IDS.has(handCard.id);
}
function pocketInstantiateBoardCard(handCard, turnNumber) {
  const inst = POCKET_FOSSIL_IDS.has(handCard.id) ? makePocketFossilInstance(handCard.id) : handCard;
  inst.boardTurn = turnNumber;
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
    p1: pocketFreshSide(p1, pRoom.p1Deck),
    p2: pocketFreshSide(p2, pRoom.p2Deck),
  };
}
function pocketFreshSide(drawn, deckIds) {
  return {
    ...drawn, active: null, bench: [], discard: [], points: 0, pendingEnergy: null,
    energyAttachedThisTurn: false, retreatedThisTurn: false, supporterUsedThisTurn: false,
    energyTypes: pocketDeckEnergyTypes(deckIds), boardReady: false,
    giovanniBoostThisTurn: false, blaineBoostNamesThisTurn: null, retreatDiscountThisTurn: 0,
    abilitiesUsedThisTurn: [], supporterLockedUntilTurn: 0,
  };
}
function pocketPickEnergy(types) {
  return types[Math.floor(Math.random() * types.length)];
}
// 第1回合（先攻方）沒有能量區能量，但雙方從第1回合就要抽牌
function pocketStartFirstTurn(G) {
  const side = G[G.turn];
  if (side.deck.length === 0) { G.winner = G.turn === 'p1' ? 'p2' : 'p1'; G.phase = 'done'; return; }
  side.hand.push(side.deck.shift());
}
// 中毒在「該側回合結束」時扣血（不是對手回合結束）——真實TCG通用時機慣例
function pocketAdvanceTurn(G) {
  const endingRole = G.turn;
  const endingSide = G[endingRole];
  if (endingSide.active && endingSide.active.status === 'poisoned') {
    endingSide.active.curHp = Math.max(0, endingSide.active.curHp - 10);
    if (endingSide.active.curHp <= 0) {
      pocketResolveActiveKO(G, endingRole);
      if (G.phase === 'forced_switch' || G.phase === 'done') return;
    }
  }
  G.turn = endingRole === 'p1' ? 'p2' : 'p1';
  G.turnNumber++;
  const side = G[G.turn];
  if (side.deck.length === 0) { G.winner = G.turn === 'p1' ? 'p2' : 'p1'; G.phase = 'done'; return; }
  side.hand.push(side.deck.shift());
  side.pendingEnergy = pocketPickEnergy(side.energyTypes);
  side.energyAttachedThisTurn = false;
  side.retreatedThisTurn = false;
  side.supporterUsedThisTurn = false;
  side.giovanniBoostThisTurn = false;
  side.blaineBoostNamesThisTurn = null;
  side.retreatDiscountThisTurn = 0;
  side.abilitiesUsedThisTurn = [];
}
// 共用的「主戰寶可夢死亡」處理：加分給對方、丟棄、視情況進入forced_switch或判定勝負。
// koRole = 死掉的那隻寶可夢的擁有者。awardPoint=false 用在「非擊倒」的移除情境（例如Sabrina/幽浮硬幣把對手主戰換走），
// 這種情況不算KO、不給分，但一樣要走「板凳空了就輸」跟「換人」流程。
function pocketResolveActiveKO(G, koRole, awardPoint = true) {
  const koSide = G[koRole];
  const otherRole = koRole === 'p1' ? 'p2' : 'p1';
  const otherSide = G[otherRole];
  const dead = koSide.active;
  if (awardPoint) {
    otherSide.points += dead.ex ? 2 : 1;
    koSide.discard.push(dead);
  }
  koSide.active = null;
  if (awardPoint && otherSide.points >= 3) { G.winner = otherRole; G.phase = 'done'; return; }
  if (koSide.bench.length) {
    G.phase = 'forced_switch';
    G.pendingSwitchRole = koRole;
    G.pendingSwitchReason = 'endTurn'; // 攻擊/中毒造成的換人＝這回合的行動已經用掉，換完人回合換對方
  } else {
    G.winner = otherRole; G.phase = 'done';
  }
}
// 板凳寶可夢被濺傷打死（不會觸發forced_switch，因為主戰沒被動到）
function pocketResolveBenchKOs(G, side, otherRole) {
  const otherSide = G[otherRole];
  side.bench = side.bench.filter(p => {
    if (p.curHp > 0) return true;
    otherSide.points += p.ex ? 2 : 1;
    side.discard.push(p);
    return false; // 從板凳移除
  });
}
function pocketCheckWin(G) {
  if (G.p1.points >= 3) { G.winner = 'p1'; G.phase = 'done'; return true; }
  if (G.p2.points >= 3) { G.winner = 'p2'; G.phase = 'done'; return true; }
  return false;
}
function pocketFlipCoin() { return Math.random() < 0.5; }
function pocketFlipCoins(n) { let h = 0; for (let i = 0; i < n; i++) if (pocketFlipCoin()) h++; return h; }
function pocketCanPayCost(pokemon, cost) {
  const need = {};
  let colorlessNeed = 0;
  for (const t of (cost || [])) {
    if (t === 'Colorless') colorlessNeed++;
    else need[t] = (need[t] || 0) + 1;
  }
  const have = {};
  for (const e of pokemon.energy) have[e] = (have[e] || 0) + 1;
  for (const t in need) {
    if ((have[t] || 0) < need[t]) return false;
    have[t] -= need[t];
  }
  const leftover = Object.values(have).reduce((a, b) => a + b, 0);
  return leftover >= colorlessNeed;
}
function pocketViewFor(G, role) {
  const op = role === 'p1' ? 'p2' : 'p1';
  const pub = side => ({ active: side.active, bench: side.bench, discard: side.discard, points: side.points, deckCount: side.deck.length });
  return {
    turn: G.turn, turnNumber: G.turnNumber, phase: G.phase, winner: G.winner, pendingSwitchRole: G.pendingSwitchRole,
    you: {
      ...pub(G[role]), hand: G[role].hand, pendingEnergy: G[role].pendingEnergy,
      energyAttachedThisTurn: G[role].energyAttachedThisTurn, retreatedThisTurn: G[role].retreatedThisTurn,
      energyTypes: G[role].energyTypes, supporterUsedThisTurn: G[role].supporterUsedThisTurn,
      abilitiesUsedThisTurn: G[role].abilitiesUsedThisTurn,
    },
    opponent: { ...pub(G[op]), handCount: G[op].hand.length },
  };
}
function pocketOneOff(pRoom, role, extra) {
  send(pRoom[role], { type: 'pocket_peek', ...extra });
}

/* ── 找own場上（主戰+板凳）某隻寶可夢，供訓練師卡/特性指定目標用 ── */
function pocketFindOwn(side, uid) { return [side.active, ...side.bench].find(p => p && p.uid === uid); }
function pocketFindOwnByName(side, names) { return [side.active, ...side.bench].find(p => p && names.includes(p.name)); }

/* ── 招式文字效果對照表（Phase 5）──
   key是TCGdex原始英文效果全文（逐字比對，不是regex猜語意，比較不會誤判）。
   handler簽名：(ctx) => void，ctx = { G, role, op, side, oppSide, attacker, defender, atk, rawDamage(可改), extraKO(bool,已內部處理KO時設true讓主流程跳過), healMirror(bool) }
   rawDamage是「弱點加成前」的傷害，函式可以直接改 ctx.rawDamage；weakness會在handler跑完後才加上去。 */
const ATTACK_EFFECTS = {
  "Discard 1 {R} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.attacker, 'Fire', 1),
  "Discard 2 {P} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.attacker, 'Psychic', 2),
  "Discard 2 {R} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.attacker, 'Fire', 2),
  "Discard a {R} Energy from this Pokémon.": ctx => pocketDiscardEnergy(ctx.attacker, 'Fire', 1),
  "Discard all Energy from this Pokémon.": ctx => { ctx.attacker.energy = []; },
  "During your opponent's next turn, the Defending Pokémon can't attack.": ctx => { ctx.defender.cantAttackUntilTurn = ctx.G.turnNumber + 1; },
  "During your opponent's next turn, the Defending Pokémon can't retreat.": ctx => { ctx.defender.cantRetreatUntilTurn = ctx.G.turnNumber + 1; },
  "During your opponent’s next turn, attacks used by the Defending Pokémon do −20 damage.": ctx => { ctx.defender.dmgDebuffUntilTurn = ctx.G.turnNumber + 1; ctx.defender.dmgDebuffAmount = 20; },
  "Flip 2 coins. This attack does 80 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(2) * 80; },
  "Flip 3 coins. Take an amount of {R} Energy from your Energy Zone equal to the number of heads and attach it to your Benched {R} Pokémon in any way you like.": ctx => {
    const heads = pocketFlipCoins(3);
    const targets = ctx.side.bench.filter(p => (p.types || []).includes('Fire'));
    for (let i = 0; i < heads && targets.length; i++) targets[i % targets.length].energy.push('Fire');
    ctx.rawDamage = 0;
  },
  "Flip 4 coins. This attack does 40 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(4) * 40; },
  "Flip 4 coins. This attack does 50 damage for each heads.": ctx => { ctx.rawDamage = pocketFlipCoins(4) * 50; },
  "Flip a coin. If heads, the Defending Pokémon can't attack during your opponent's next turn.": ctx => { if (pocketFlipCoin()) ctx.defender.cantAttackUntilTurn = ctx.G.turnNumber + 1; ctx.rawDamage = 0; },
  "Flip a coin. If heads, this attack does 40 more damage.": ctx => { if (pocketFlipCoin()) ctx.rawDamage += 40; },
  "Flip a coin. If heads, this attack does 40 more damage. If tails, this Pokémon also does 20 damage to itself.": ctx => {
    if (pocketFlipCoin()) ctx.rawDamage += 40;
    else ctx.selfDamage = (ctx.selfDamage || 0) + 20;
  },
  "Flip a coin. If heads, your opponent shuffles their Active Pokémon into their deck.": ctx => {
    if (!pocketFlipCoin()) { ctx.rawDamage = 0; return; }
    ctx.rawDamage = 0;
    if (ctx.defender) {
      ctx.oppSide.deck.push(ctx.defender);
      ctx.oppSide.deck = pocketShuffle(ctx.oppSide.deck);
      pocketResolveActiveKO(ctx.G, ctx.op, false);
      ctx.skipMainDamage = true;
    }
  },
  "Flip a coin. If heads, your opponent's Active Pokémon is now Paralyzed.": ctx => { if (pocketFlipCoin() && ctx.defender) ctx.defender.status = 'paralyzed'; },
  "Flip a coin. If tails, this attack does nothing.": ctx => { if (!pocketFlipCoin()) ctx.rawDamage = 0; },
  "Heal 30 damage from this Pokémon.": ctx => { ctx.attacker.curHp = Math.min(ctx.attacker.hp, ctx.attacker.curHp + 30); },
  "Heal from this Pokémon the same amount of damage you did to your opponent's Active Pokémon.": ctx => { ctx.healMirror = true; },
  "If this Pokémon has at least 2 extra {W} Energy attached, this attack does 60 more damage.": ctx => {
    const have = ctx.attacker.energy.filter(e => e === 'Water').length;
    const need = (ctx.atk.cost || []).filter(t => t === 'Water').length;
    if (have - need >= 2) ctx.rawDamage += 60;
  },
  "If your opponent's Active Pokémon is Poisoned, this attack does 50 more damage.": ctx => { if (ctx.defender?.status === 'poisoned') ctx.rawDamage += 50; },
  "Switch this Pokémon with 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) {
      const i = Math.floor(Math.random() * ctx.side.bench.length);
      const bench = ctx.side.bench[i];
      ctx.side.bench[i] = ctx.attacker;
      ctx.side.active = bench;
    }
    ctx.rawDamage = 0;
  },
  "This Pokémon also does 20 damage to itself.": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 20; },
  "This Pokémon also does 50 damage to itself.": ctx => { ctx.selfDamage = (ctx.selfDamage || 0) + 50; },
  "This attack also does 10 damage to each of your opponent's Benched Pokémon.": ctx => {
    for (const p of ctx.oppSide.bench) p.curHp = Math.max(0, p.curHp - 10);
  },
  "This attack also does 30 damage to 1 of your Benched Pokémon.": ctx => {
    if (ctx.side.bench.length) {
      const t = ctx.side.bench[Math.floor(Math.random() * ctx.side.bench.length)];
      t.curHp = Math.max(0, t.curHp - 30);
    }
  },
  "This attack does 30 damage for each of your Benched {L} Pokémon.": ctx => {
    const n = ctx.side.bench.filter(p => (p.types || []).includes('Lightning')).length;
    ctx.rawDamage = n * 30;
  },
  "This attack does 30 damage to 1 of your opponent's Pokémon.": ctx => {
    ctx.rawDamage = 0;
    const pool = ctx.oppSide.bench.length ? ctx.oppSide.bench : (ctx.defender ? [ctx.defender] : []);
    if (pool.length) { const t = pool[Math.floor(Math.random() * pool.length)]; t.curHp = Math.max(0, t.curHp - 30); }
  },
  "This attack does 30 more damage for each Energy attached to your opponent's Active Pokémon.": ctx => {
    ctx.rawDamage += 30 * (ctx.defender?.energy.length || 0);
  },
  "Your opponent can't use any Supporter cards from their hand during their next turn.": ctx => {
    ctx.oppSide.supporterLockedUntilTurn = ctx.G.turnNumber + 1;
  },
  "Your opponent reveals their hand.": ctx => { ctx.peekOpponentHand = true; },
  "Your opponent's Active Pokémon is now Asleep.": ctx => { if (ctx.defender) ctx.defender.status = 'asleep'; },
  "Your opponent's Active Pokémon is now Poisoned.": ctx => { if (ctx.defender) ctx.defender.status = 'poisoned'; },
};
function pocketDiscardEnergy(pokemon, type, n) {
  for (let i = 0; i < n; i++) {
    const idx = pokemon.energy.indexOf(type);
    if (idx >= 0) pokemon.energy.splice(idx, 1);
  }
}

/* ── 訓練師卡效果表（Phase 5）── key用卡片id（同名重印卡id不同，統一用A1原版/PromoA原版的id）
   handler簽名：(ctx, msg) => string|null，回傳錯誤訊息字串代表不合法擋下，null代表成功。 */
const TRAINER_EFFECTS = {
  'P-A-001': (ctx, msg) => { // Potion：治療己方1隻20血
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target) return '請選擇要治療的寶可夢';
    target.curHp = Math.min(target.hp, target.curHp + 20);
    return null;
  },
  'P-A-002': (ctx) => { ctx.side.retreatDiscountThisTurn = 1; return null; }, // X Speed
  'P-A-003': (ctx) => { ctx.peekHand = ctx.oppSide.hand; return null; }, // Hand Scope
  'P-A-004': (ctx) => { ctx.peekDeck = ctx.side.deck.slice(0, 3); return null; }, // Pokédex
  'P-A-005': (ctx) => { // Poké Ball
    const idxs = ctx.side.deck.map((c, i) => (c.category === 'Pokemon' && c.stage === 'Basic') ? i : -1).filter(i => i >= 0);
    if (!idxs.length) return '牌庫中沒有基礎寶可夢';
    const i = idxs[Math.floor(Math.random() * idxs.length)];
    ctx.side.hand.push(ctx.side.deck.splice(i, 1)[0]);
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
    target.curHp = Math.min(target.hp, target.curHp + 50);
    return null;
  },
  'A1-220': (ctx, msg) => { // Misty：選1隻水屬性，連續丟硬幣直到反面，正面各+1水能量
    const target = pocketFindOwn(ctx.side, msg.target);
    if (!target || !(target.types || []).includes('Water')) return '目標必須是水屬性寶可夢';
    while (pocketFlipCoin()) target.energy.push('Water');
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
  'A1-224': (ctx) => { // Brock：幫場上的Golem/Onix附1個格鬥能量
    const target = pocketFindOwnByName(ctx.side, ['Golem', 'Onix']);
    if (!target) return '場上沒有Golem或Onix';
    target.energy.push('Fighting');
    return null;
  },
  'A1-225': (ctx) => { // Sabrina：把對手主戰換到板凳，對手選新主戰
    if (!ctx.oppSide.active) return '對手沒有主戰寶可夢';
    ctx.oppSide.bench.push(ctx.oppSide.active);
    ctx.oppSide.active = null;
    ctx.G.phase = 'forced_switch';
    ctx.G.pendingSwitchRole = ctx.op;
    ctx.G.pendingSwitchReason = 'noEndTurn'; // 支援者卡不會結束回合，換完人回合還是你的
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
};

/* ── 特性(ability)：每回合限用1次的主動觸發型（key用ability.name）。
   被動常駐型（Gengar ex「詭異束縛」擋支援者卡）不在這裡，是在打出支援者卡時直接檢查對方主戰是不是Gengar ex。 */
const ABILITY_EFFECTS = {
  'Volt Charge': (ctx, poke) => { // Magneton：每回合1次，從能量區拿1電能量附到自己身上
    if (!ctx.side.energyTypes.includes('Lightning')) return '你的能量區沒有電屬性能量';
    poke.energy.push('Lightning');
    return null;
  },
  'Sleep Pendulum': (ctx) => { // Hypno：每回合1次，丟硬幣，正面讓對方主戰睡著
    if (ctx.oppSide.active && pocketFlipCoin()) ctx.oppSide.active.status = 'asleep';
    return null;
  },
  'Psy Shadow': (ctx) => { // Gardevoir：每回合1次，從能量區拿1超能力能量附給場上是超能力屬性的主戰
    if (!ctx.side.active || !(ctx.side.active.types || []).includes('Psychic')) return '主戰必須是超能力屬性';
    if (!ctx.side.energyTypes.includes('Psychic')) return '你的能量區沒有超能力屬性能量';
    ctx.side.active.energy.push('Psychic');
    return null;
  },
  'Gas Leak': (ctx, poke) => { // Weezing：只有在主戰位置時，每回合1次讓對方主戰中毒
    if (ctx.side.active?.uid !== poke.uid) return 'Weezing必須在主戰位置才能使用特性';
    if (ctx.oppSide.active) ctx.oppSide.active.status = 'poisoned';
    return null;
  },
};
function pocketBroadcastState(pRoom) {
  const G = pRoom.G;
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
  triggerOnEnterSrv(G.p1Deck[0], 'p1', G, startLog);
  triggerOnEnterSrv(G.p2Deck[0], 'p2', G, startLog);
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
      pet: { speciesId: rows[0].species_id, happiness: rows[0].happiness, coins: rows[0].coins, hunger, ...balls, fishTankPos, fishDexPos, birdcagePos, pokeDisplayIds, pokeDisplayPos, pokeDisplayFlipped },
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
    if (pRoom) {
      if (ws.pocketRole === 'spectator') {
        pRoom.spectators = (pRoom.spectators || []).filter(s => s !== ws);
      } else {
        const op = ws.pocketRole === 'p1' ? 'p2' : 'p1';
        send(pRoom[op], { type: 'pocket_opponent_disconnected' });
        pRoom[ws.pocketRole] = null;
        if (pRoom.phase !== 'done' || (!pRoom.p1 && !pRoom.p2)) pocketRooms.delete(ws.pocketRoomCode);
      }
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
      const pRoom = { code, p1: ws, p2: null, phase: 'waiting', p1Deck: null, p2Deck: null, p1Ready: false, p2Ready: false, firstPlayer: null, p1UserId: ws.userId ?? null, p2UserId: null, p1Username: ws.username ?? null, p2Username: null, spectators: [] };
      pocketRooms.set(code, pRoom);
      ws.pocketRoomCode = code; ws.pocketRole = 'p1';
      send(ws, { type: 'pocket_room_created', code, role: 'p1' });
      return;
    }

    if (type === 'pocket_join_room') {
      const code = (msg.code || '').toUpperCase().trim();
      const pRoom = pocketRooms.get(code);
      if (!pRoom) { send(ws, { type: 'error', message: '找不到房間，請確認代碼' }); return; }
      if (pRoom.p2) {
        pRoom.spectators = pRoom.spectators || [];
        pRoom.spectators.push(ws);
        ws.pocketRoomCode = code; ws.pocketRole = 'spectator';
        send(ws, { type: 'pocket_spectate_joined', phase: pRoom.phase });
        return;
      }
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
      if (pRole === 'p1') { pRoom.p1Deck = msg.deck; pRoom.p1Ready = true; }
      else                { pRoom.p2Deck = msg.deck; pRoom.p2Ready = true; }
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
      const activeCard = pocketInstantiateBoardCard(activeHandCard, G.turnNumber);
      side.active = activeCard;
      side.bench = benchHandCards.map(c => pocketInstantiateBoardCard(c, G.turnNumber));
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
      const G = pRoom.G; const role = ws.pocketRole;
      if (G.turn !== role) return;
      const side = G[role];
      if (!side.pendingEnergy || side.energyAttachedThisTurn) { send(ws, { type: 'error', message: '沒有可附加的能量' }); return; }
      const target = [side.active, ...side.bench].find(p => p && p.uid === msg.target);
      if (!target) return;
      target.energy.push(side.pendingEnergy);
      side.pendingEnergy = null;
      side.energyAttachedThisTurn = true;
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
      side.bench.push(pocketInstantiateBoardCard(card, G.turnNumber));
      side.hand = side.hand.filter(c => c.uid !== card.uid);
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
      }
      const handler = TRAINER_EFFECTS[card.id];
      if (!handler) { send(ws, { type: 'error', message: '這張卡的效果尚未實作' }); return; }
      const ctx = { G, role, op, side, oppSide, pRoom };
      const err = handler(ctx, msg);
      if (err) { send(ws, { type: 'error', message: err }); return; }
      side.hand = side.hand.filter(c => c.uid !== card.uid);
      side.discard.push(card);
      if (isSupporter) side.supporterUsedThisTurn = true;
      if (ctx.peekHand) send(ws, { type: 'pocket_peek', title: '對手手牌', cards: ctx.peekHand });
      if (ctx.peekDeck) send(ws, { type: 'pocket_peek', title: '牌庫頂3張', cards: ctx.peekDeck });
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
      if (side.abilitiesUsedThisTurn.includes(poke.uid)) { send(ws, { type: 'error', message: '這隻寶可夢這回合已經用過特性了' }); return; }
      const err = ABILITY_EFFECTS[ability.name]({ G, role, op, side, oppSide }, poke);
      if (err) { send(ws, { type: 'error', message: err }); return; }
      side.abilitiesUsedThisTurn.push(poke.uid);
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
      if (handCard.evolveFrom !== target.name) { send(ws, { type: 'error', message: '進化對象不符' }); return; }
      if (target.boardTurn >= G.turnNumber) { send(ws, { type: 'error', message: '這隻寶可夢這回合不能進化' }); return; }
      const preservedDamage = (target.hp || 0) - (target.curHp ?? target.hp ?? 0);
      const preservedEnergy = target.energy;
      const preservedUid = target.uid;
      Object.assign(target, structuredClone(POCKET_CARDS_BY_ID[handCard.id]));
      target.uid = preservedUid;
      target.energy = preservedEnergy;
      target.curHp = Math.max(1, (target.hp || 0) - preservedDamage);
      target.boardTurn = G.turnNumber;
      side.hand = side.hand.filter(c => c.uid !== handCard.uid);
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
      const cost = Math.max(0, (active.retreat || 0) - (side.retreatDiscountThisTurn || 0));
      if (active.energy.length < cost) { send(ws, { type: 'error', message: '能量不足，無法撤退' }); return; }
      const idx = side.bench.findIndex(p => p.uid === msg.target);
      if (idx < 0) return;
      active.energy.splice(0, cost);
      const target = side.bench[idx];
      side.bench[idx] = active;
      side.active = target;
      side.retreatedThisTurn = true;
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
      const atk = attacker?.attacks?.[msg.attackIndex];
      if (!atk) return;
      if (attacker.status === 'paralyzed') { send(ws, { type: 'error', message: '麻痺中無法攻擊' }); attacker.status = null; pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return; }
      if (attacker.status === 'asleep') {
        if (!pocketFlipCoin()) { send(ws, { type: 'error', message: '睡眠中，攻擊失敗' }); pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return; }
        attacker.status = null;
      }
      if (attacker.cantAttackUntilTurn === G.turnNumber) { send(ws, { type: 'error', message: '這回合這隻寶可夢不能攻擊' }); pocketAdvanceTurn(G); pocketBroadcastState(pRoom); return; }
      if (!pocketCanPayCost(attacker, atk.cost)) { send(ws, { type: 'error', message: '能量不足，無法使用這個招式' }); return; }
      const defender = oppSide.active;
      if (!defender) return;

      const ctx = { G, role, op, side, oppSide, attacker, defender, atk, rawDamage: parseInt(String(atk.damage || '0').replace(/\D+/g, ''), 10) || 0, selfDamage: 0 };
      const effectFn = atk.effect && ATTACK_EFFECTS[atk.effect];
      if (effectFn) effectFn(ctx);

      let mainDamage = 0;
      if (!ctx.skipMainDamage && ctx.rawDamage > 0) {
        mainDamage = ctx.rawDamage;
        if (side.giovanniBoostThisTurn) mainDamage += 10;
        if (side.blaineBoostNamesThisTurn?.includes(attacker.name)) mainDamage += 30;
        const weak = (defender.weaknesses || []).find(w => (attacker.types || []).includes(w.type));
        if (weak) mainDamage += parseInt(String(weak.value).replace(/\D+/g, ''), 10) || 0;
        if (defender.dmgDebuffUntilTurn === G.turnNumber) mainDamage = Math.max(0, mainDamage - defender.dmgDebuffAmount);
        defender.curHp = Math.max(0, (defender.curHp ?? defender.hp ?? 0) - mainDamage);
      }
      if (ctx.selfDamage) attacker.curHp = Math.max(0, attacker.curHp - ctx.selfDamage);
      if (ctx.healMirror) attacker.curHp = Math.min(attacker.hp, attacker.curHp + mainDamage);

      // 板凳濺傷造成的擊倒先處理（不會觸發forced_switch，因為主戰沒被打）
      pocketResolveBenchKOs(G, oppSide, role);
      pocketResolveBenchKOs(G, side, op); // 例如Raging Thunder自己的板凳也可能被自己招式波及

      if (ctx.peekOpponentHand) send(ws, { type: 'pocket_peek', title: '對手手牌', cards: oppSide.hand });

      if (pocketCheckWin(G)) { pocketBroadcastState(pRoom); return; }

      if (!ctx.skipMainDamage && attacker.curHp <= 0 && side.active === attacker) {
        // 自傷/自損打死自己（例如波導彈/雙倍拳頭）——一樣算作被擊倒，對方加分
        pocketResolveActiveKO(G, role);
        pocketBroadcastState(pRoom); return;
      }
      if (!ctx.skipMainDamage && defender.curHp <= 0 && oppSide.active === defender) {
        pocketResolveActiveKO(G, op);
        pocketBroadcastState(pRoom); return;
      }
      // Aerodactyl的「洗回牌庫」效果已經在effect handler內自己呼叫過pocketResolveActiveKO(false)，
      // 這裡如果已經進入forced_switch/done就不要再往下走
      if (G.phase === 'forced_switch' || G.phase === 'done') { pocketBroadcastState(pRoom); return; }

      pocketAdvanceTurn(G);
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
      const chosen = side.bench[idx];
      side.bench.splice(idx, 1);
      side.active = chosen;
      G.pendingSwitchRole = null;
      G.phase = 'active';
      if (G.pendingSwitchReason === 'endTurn') pocketAdvanceTurn(G);
      G.pendingSwitchReason = null;
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
        triggerOnEnterSrv(target, op, G, log, false); // 不觸發上場特性／進場陷阱

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
      const atkCost = effectiveCostSrv(atk, defender, G, aBuff, attacker, op);
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
        drawForRole(G, op);
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
        G.turn = op;
        G[`${role}SuppUsed`] = false;
        G[`${role}HandCardUsed`] = false;
        G[`${role}FreeSwitch`] = false;
        G[`${role}SwitchedThisTurn`] = false;
        G[`${op}SwitchGuard`] = false; // guard only lasts one enemy turn, even if that turn was skipped
        G[`${op}StandbyGuard`] = false; // 格擋同樣只保護一個對方回合，即使那回合被跳過
        G[`${op}Buff`].reflect = false; G[`${op}Braced`] = false; G[`${op}CoinShield`] = false; G[`${op}Buff`].debuffReflect = false; // all expire if opponent never attacked (status skip)
        G[`${role}Buff`].ignoreReflectNext = false; // 盧恩啟示：無視反彈鏡buff沒打出去就失效（搏命免疫改成回合戳記到期制，見rune-revelation case）
        drawForRole(G, op);
        broadcast(room, { type: 'update', state: G, log, actor: role }); return;
      }

      const switchGuardMult = G[`${op}SwitchGuard`] ? 0.9 : 1;
      G[`${op}SwitchGuard`] = false; // consumed by this incoming attack
      // 格擋（原待機）：下一次受到的攻擊傷害×0.6，跟switchGuard同一套「不論有沒有真的扣血都消耗」寫法
      const standbyGuardMult = G[`${op}StandbyGuard`] ? 0.6 : 1;
      G[`${op}StandbyGuard`] = false; // consumed by this incoming attack
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
        doAttack(attacker, defender, atk, aBuff, dBuff, log, G, switchGuardMult, standbyGuardMult);
        // 羅馬鬥技場：鬥屬性攻擊額外發動第二次（傷害減半）。防禦方沒被第一下打倒的話這裡直接
        // 補打，讓後面既有的attackerDied/defenderDied判斷自然吃到兩下打完的最終狀態；如果第一下
        // 就把防禦方打倒了，改記錄在G[op+PendingColosseumHit]，等對方選完KO替補（ko_switch handler）
        // 才真正對新上場的寶可夢補打第二下，跟pokemon_battle.html的attackWithColosseumDouble同一套邏輯
        const atkTypeForColosseum = aBuff.typeOverride || atk.type;
        if (G.activeStadium?.id === 'stadium-colosseum' && atkTypeForColosseum === 'fighting' && attacker.cur > 0) {
          const secondAtk = { ...atk, _halfDamage: true }; // 見doAttack內_halfDamage的說明，不能只砍atk.dmg
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
      const deck   = G[`${role}Deck`];
      const curIdx = G[`${role}Idx`];
      const newIdx = msg.deckIdx;
      if (newIdx === curIdx || !deck[newIdx] || deck[newIdx].cur <= 0) return;

      const usedFreeSwitch = G[`${role}FreeSwitch`]; // 撤退背心：免費換場，不結束回合
      const outPoke = deck[curIdx];
      if (outPoke.status?.type === 'confusion') outPoke.status = null;
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

      // 2026-07-23應使用者要求：換寶可夢也能抽到1張支援者卡，提升換人的強度
      const drawnCard = pickSupporterAvoidingDupes(G[`${role}Hand`]);
      G[`${role}Hand`].push(drawnCard);
      G[`${role}NeedsDiscard`] = G[`${role}Hand`].length > 7;

      if (usedFreeSwitch) {
        const log = [{ text: `換上了 ${deck[newIdx].name}！（撤退背心：不消耗回合）本回合傷害減免中…抽到了【${drawnCard.name}】！`, cls: 'player' }];
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
      const log = [{ text: `換上了 ${deck[newIdx].name}！本回合傷害減免中…抽到了【${drawnCard.name}】！`, cls: 'player' }];
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
        let log;
        if (G.activeStadium?.id === 'stadium-ghost-curse') {
          log = [{ text: `亡靈墓園場地啟用中，異常狀態無法被解除！`, cls: 'system' }];
        } else if (active.status || active.status2) {
          const cured = [active.status, active.status2].filter(Boolean).map(st => STATUS_ZH[st.type] || st.type);
          active.status = null;
          active.status2 = null;
          log = [{ text: `棄牌解除了${active.name}的${cured.join('、')}！`, cls: 'system' }];
        } else {
          log = [{ text: `${active.name}目前沒有異常狀態。`, cls: 'system' }];
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
