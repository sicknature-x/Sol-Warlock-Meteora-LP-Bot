'use strict';
// Paper portfolio adapter: one shared USDC ledger, native buffer isolated per position.
function positions(book){return Array.isArray(book?.positions)?book.positions:(book?.position?[book.position]:[]);}
function migrate(book){
 if(!Array.isArray(book.positions)){
  book.positions=book.position?[book.position]:[];
  if(book.position)book.position.reserveSol=+(book.virtual.sol||0);
  if(book.position)book.virtual.sol=0;
 }
 book.position=null;
 return book;
}
function duplicate(book,pool,mint,except){return positions(book).some(p=>p!==except&&(p.pool===pool||(!!mint&&p.mintX===mint)));}
function budget(book,settings){
 const slots=Math.max(0,settings.MAX_POSITIONS-positions(book).length),cash=+book.virtual.usdc||0;
 if(!slots)return 0;
 return settings.POSITION_USDC>0?(cash>=settings.POSITION_USDC?settings.POSITION_USDC:0):cash/slots;
}
function view(book,pos){return {...book,positions:undefined,position:pos,virtual:{...book.virtual,sol:pos.reserveSol||0}};}
function commit(book,old,leg){
 if(!Number.isFinite(leg.virtual.usdc)||leg.virtual.usdc< -1e-8)throw Error('Invalid paper cash');
 if(leg.virtual.capitalSol!=null&&(!Number.isFinite(leg.virtual.capitalSol)||leg.virtual.capitalSol< -1e-8))throw Error('Invalid paper SOL cash');
 book.virtual.usdc=Math.max(0,leg.virtual.usdc);
 if(leg.virtual.capitalSol!=null)book.virtual.capitalSol=Math.max(0,leg.virtual.capitalSol);
 const i=book.positions.indexOf(old);
 if(i<0)throw Error('Position identity changed');
 if(leg.position){leg.position.reserveSol=leg.virtual.sol||0;book.positions[i]=leg.position;}
 else book.positions.splice(i,1);
 book.history=leg.history;book.reshapes=leg.reshapes;
 if(leg.rightRepositionEvents)book.rightRepositionEvents=leg.rightRepositionEvents;
}
function append(book,leg,allocation){
 const spent=allocation-leg.virtual.usdc;
 if(!leg.position||!Number.isFinite(spent)||spent<0||spent>book.virtual.usdc+1e-8)throw Error('Insufficient paper USDC');
 leg.position.reserveSol=leg.virtual.sol||0;
 book.virtual.usdc=Math.max(0,book.virtual.usdc-spent);
 book.positions.push(leg.position);
 return leg.position;
}
module.exports={positions,migrate,duplicate,budget,view,commit,append};
