'use strict';
// Can run against git-archived 0.5.36 without the new service/client API.
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('path'),fs=require('fs'),vm=require('vm');
const source=path.resolve(process.env.ANIME_RATINGS_SOURCE || path.join(__dirname,'..'));
const metadata=require(path.join(source,'src/metadata')),Ratings=require(path.join(source,'src/episode-ratings'));
const reply=json=>({ok:true,status:200,json:async()=>json});
const edges=(count,offset=0,season=1)=>Array.from({length:count},(_,i)=>({node:{id:'tt'+(10000+offset+i),titleText:{text:'Title '+(offset+i)},series:{episodeNumber:{episodeNumber:offset+i+1,seasonNumber:season}},ratingsSummary:{aggregateRating:7}}}));
const page=(nodes,total,next,cursor)=>({data:{title:{id:'tt0388629',titleText:{text:'One Piece'},ratingsSummary:{aggregateRating:9},episodes:{seasons:[{number:0},{number:1}],episodes:{edges:nodes,total,pageInfo:{hasNextPage:next,endCursor:cursor}}}}}});
test('completed empty request releases renderer loading state',async()=>{
  const app=fs.readFileSync(path.join(source,'renderer/app.js'),'utf8');
  const start=app.includes('const ratingsKey=')?app.indexOf('const ratingsKey='):app.indexOf('async function loadSeriesRatings');
  const lib={series:[{id:'s',title:'No IMDb',episodes:[]}],settings:{}};
  const context={state:{lib,view:{name:'home'},ratingLoads:{}},getSeries:()=>lib.series[0],api:{invoke:async()=>lib},call:async()=>lib,render:()=>{},setTimeout,clearTimeout};vm.createContext(context);
  await vm.runInContext(app.slice(start,app.indexOf('function render()',start))+'\nloadSeriesRatings("s")',context);
  assert.equal(context.state.ratingLoads.s.status,'empty');assert.equal(context.state.ratingLoads.s.pending,null);
});
test('legacy metadata API retrieves every page past 1000',async t=>{
  const original=global.fetch;let calls=0;global.fetch=async()=>reply(page(edges(calls===4?200:250,calls*250),1200,calls<4,`c${calls++}`));t.after(()=>global.fetch=original);
  const chart=await metadata.fetchImdbData({imdbId:'tt0388629'});assert.equal(chart.seasons.flatMap(s=>s.episodes).length,1200);assert.equal(chart.complete,true);assert.equal(calls,5);
});
test('legacy metadata API retains season zero',async t=>{
  const original=global.fetch;global.fetch=async()=>reply(page(edges(1,0,0),1,false,null));t.after(()=>global.fetch=original);
  const chart=await metadata.fetchImdbData({imdbId:'tt0388629'});assert.equal(chart.seasons.find(s=>s.season===0)?.episodes.length,1);
});
test('confirmed persistent IMDb mapping survives partial refresh',()=>{
  const identity={imdbId:'tt1',episodeId:'tt2',seriesId:'s',number:1,season:2,episodeNumber:1,method:'unique-episode-title'};
  const series={id:'s',title:'Saga Part 2',episodes:[{id:'e',number:1,rating:8,ratingSource:'IMDb',ratingIdentity:identity}]};
  Ratings.apply(series,{imdbId:'tt1',title:'Saga',complete:false,seasons:[]});assert.equal(series.episodes[0].rating,8);assert.deepEqual(series.episodes[0].ratingIdentity,identity);
});
