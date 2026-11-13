"use strict";
const DEFAULTS={QUOTE_FAILURE_POLLS:10,RANGE_DOWN_PCT:50,LOWER_BINS:0,RANGE_UP_PCT:0,OPEN_SHAPE:'MIXED',OPEN_SPOT_PCT:50,RESHAPE_ENABLED:true,COMPOUND_ENABLED:true,COMPOUND_SPOT_PCT:50,RESHAPE_SHAPE:'BIDASK',MAX_POSITION_TVL_PCT:5};
const KEYS=[...Object.keys(DEFAULTS),'UPPER_BUFFER_BINS','RESHAPE_N','TP','TP_USD_PCT','OOR_RIGHT_CLOSE','OOR_RIGHT_CONFIRM_POLLS','OOR_RIGHT_MIN_BINS','OOR_RIGHT_REPOSITION_MIN_PNL_PCT','OOR_RIGHT_MIN_PROFIT_PCT','OOR_RIGHT_MAX_REPOSITIONS','TRAIL_ENABLED','TRAIL_ARM_PCT','TRAIL_DROP_PCT','OOR_MAX_MIN','EMERGENCY_DROP','MAX_HOURS','GAS_BUFFER_SOL'];
function snapshot(c){return Object.fromEntries(KEYS.filter(k=>c[k]!==undefined||DEFAULTS[k]!==undefined).map(k=>[k,c[k]??DEFAULTS[k]]));}
function geometry(step,c,max=1400){const base=1+step/1e4,upper=c.RANGE_UP_PCT>0?Math.ceil(Math.log(1+c.RANGE_UP_PCT/100)/Math.log(base)):(c.UPPER_BUFFER_BINS??0);const n=Math.min(max-1-upper,c.LOWER_BINS>0?c.LOWER_BINS:Math.ceil(Math.log(1/(1-(c.RANGE_DOWN_PCT??50)/100))/Math.log(base)));if(!(n>=1&&upper>=0&&n+upper<=max))throw Error('Range/bin count exceeds SDK limit');return {n,upper,bins:n+upper,downPct:(1-Math.pow(base,-n))*100,lowerBinPricePct:(1-Math.pow(base,1-n))*100,upPct:(Math.pow(base,upper)-1)*100};}
function skip(g){return g.bins>=50&&g.downPct>=49-1e-9;}
function reason(g){return `MAX_NONREFUND_SOL dilewati: ${g.bins} bin, coverage bawah ${g.downPct.toFixed(2)}% memenuhi target 50% (toleransi pembulatan 49%); tanpa menunggu RPC rent (biaya tetap dihitung)`;}
module.exports={DEFAULTS,KEYS,snapshot,geometry,skip,reason};
