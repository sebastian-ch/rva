import { describe, expect, it } from 'vitest';
import { bridgeLift, deckHeight, parseDeck } from './roads';

describe('bridge decks', () => {
  it('parses the pipeline deck string and rejects bad input', () => {
    expect(parseDeck('[0,0,10,100,0,20]')).toEqual({ x0: 0, y0: 0, z0: 10, x1: 100, y1: 0, z1: 20 });
    expect(parseDeck([0, 0, 10, 100, 0, 20])).toEqual({ x0: 0, y0: 0, z0: 10, x1: 100, y1: 0, z1: 20 });
    expect(parseDeck(null)).toBeNull();
    expect(parseDeck('nope')).toBeNull();
    expect(parseDeck('[1,2,3]')).toBeNull();
  });
  it('interpolates deck height between the banks and clamps beyond the ends', () => {
    const d = parseDeck('[0,0,10,100,0,20]')!;
    expect(deckHeight(d, 0, 0)).toBeCloseTo(10);
    expect(deckHeight(d, 50, 0)).toBeCloseTo(15);
    expect(deckHeight(d, 50, 30)).toBeCloseTo(15); // off-axis points project onto the deck line
    expect(deckHeight(d, 150, 0)).toBeCloseTo(20);
    expect(deckHeight(d, -50, 0)).toBeCloseTo(10);
  });
  it('lifts decks by a thickness only, so bridges meet their approaches at grade', () => {
    expect(bridgeLift(1)).toBeGreaterThan(0);
    expect(bridgeLift(1)).toBeLessThan(1.5);
    expect(bridgeLift(0)).toBe(bridgeLift(2));
  });
});

it('keeps a supplied deck profile straight above a noisy terrain sample',async()=>{
 const {buildRoads}=await import('./roads');
 const road={type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:[[0,0],[100,0]] as [number,number][]},properties:{id:'bridge',name:null,highway:'primary',lanes:2,width:8,oneway:false,surface:'asphalt',sidewalk:false,bridge:true,tunnel:false,layer:1,deck:[0,0,10,100,0,12]}};
 const result=buildRoads([road],[],[],(x,y)=>[x,-y],x=>x>30&&x<70?30:0,{markings:false,bridges:false});
 for(const path of result.paths) for(const p of path) expect(p.y).toBeLessThan(14);
 expect(result.paths.length).toBeGreaterThan(0);
});

it('does not stamp ground-level junction squares onto joined bridge segments',async()=>{
 const {buildRoads}=await import('./roads');
 const features=[[[0,0],[20,0]],[[20,0],[40,0]],[[20,0],[20,20]]].map((coordinates,i)=>({
  type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:coordinates as [number,number][]},
  properties:{id:`bridge-${i}`,name:null,highway:'primary',lanes:2,width:8,oneway:false,surface:'asphalt',sidewalk:true,bridge:true,tunnel:false,layer:1,deck:[...coordinates[0],20,...coordinates[1],20]},
 }));
 const result=buildRoads(features,[],[],(x,y)=>[x,-y],()=>0,{markings:false,bridges:false});
 const positions=result.roads.getAttribute('position');
 for(let i=0;i<positions.count;i++) expect(positions.getY(i)).toBeGreaterThan(20);
});

it('keeps ground-supported approaches and traffic above terrain while preserving the deck landing',async()=>{
 const {buildRoads}=await import('./roads');
 const ground=(x:number)=>8*Math.sin(Math.PI*x/100);
 const road={type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:[[0,0],[100,0]] as [number,number][]},properties:{id:'approach',name:null,highway:'motorway',lanes:2,width:8,oneway:true,surface:'asphalt',sidewalk:false,bridge:false,ramp:true,tunnel:false,layer:0,deck:[0,0,0,100,0,4]}};
 const result=buildRoads([road],[],[],(x,y)=>[x,-y],ground,{markings:false,bridges:false});
 expect(result.paths[0].at(-1)!.y).toBeCloseTo(4.28);
 for(const path of result.paths) for(const p of path) expect(p.y).toBeGreaterThanOrEqual(ground(p.x)+0.27);
 const positions=result.roads.getAttribute('position');
 for(let i=0;i<positions.count;i++) expect(positions.getY(i)).toBeGreaterThan(ground(positions.getX(i))+0.18);
});

it('does not generate duplicate sidewalks when both sides are separately mapped',async()=>{
 const {buildRoads}=await import('./roads');
 const road={type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:[[0,0],[100,0]] as [number,number][]},properties:{id:'road',name:null,highway:'primary',lanes:2,width:8,oneway:true,surface:'asphalt',sidewalk:false,sidewalk_left:false,sidewalk_right:false,bridge:false,tunnel:false,layer:0}};
 const result=buildRoads([road],[],[],(x,y)=>[x,-y],()=>0,{markings:false,bridges:false});
 expect(result.walkPaths).toHaveLength(0);
 const positions=result.roads.getAttribute('position');
 for(let i=0;i<positions.count;i++) expect(Math.abs(positions.getZ(i))).toBeLessThanOrEqual(4);
});

it('retains pedestrian crossing connectivity without a solid sidewalk across the road',async()=>{
 const {buildRoads}=await import('./roads');
 const road={type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:[[0,0],[10,0]] as [number,number][]},properties:{id:'crossing',name:null,highway:'footway',footway:'crossing',lanes:null,width:2,oneway:false,surface:'asphalt',sidewalk:false,bridge:false,tunnel:false,layer:0}};
 const result=buildRoads([road],[],[],(x,y)=>[x,-y],()=>0,{markings:false});
 expect(result.walkPaths).toHaveLength(1);
 expect(result.roads.getAttribute('position').count).toBe(0);
});

it('centres marked crossings on the road and omits unmarked paint', async () => {
 const {buildRoads}=await import('./roads');
 const {hex}=await import('./props');
 const road={type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:[[0,0],[20,0]] as [number,number][]},properties:{id:'main',name:null,highway:'primary',lanes:1,width:8,oneway:true,surface:'asphalt',sidewalk:false,bridge:false,tunnel:false,layer:0}};
 const crossing=(kind:'uncontrolled'|'unmarked', offset=3)=>({type:'Feature' as const,geometry:{type:'Point' as const,coordinates:[10,offset] as [number,number]},properties:{id:`crossing-${kind}-${offset}`,crossing:kind}});
 const marked=buildRoads([road],[],[crossing('uncontrolled')],(x,y)=>[x,-y],()=>0,{markings:true,bridges:false}).roads;
 const unmarked=buildRoads([road],[],[crossing('unmarked')],(x,y)=>[x,-y],()=>0,{markings:true,bridges:false}).roads;
 expect(marked.getAttribute('position').count).toBeGreaterThan(unmarked.getAttribute('position').count);
 const pos=marked.getAttribute('position'),color=marked.getAttribute('color'),paint=hex('lane_paint');
 const z:number[]=[];
 for(let i=0;i<pos.count;i++) if(Math.abs(color.getX(i)-paint.r)<1e-6 && Math.abs(color.getY(i)-paint.g)<1e-6) z.push(pos.getZ(i));
 expect(Math.min(...z)).toBeLessThan(-3.5);
 expect(Math.max(...z)).toBeGreaterThan(3.5);
 expect((Math.min(...z)+Math.max(...z))/2).toBeCloseTo(0,1);
});

it('deduplicates paired curb crossing nodes after projecting them onto the road',async()=>{
 const {buildRoads}=await import('./roads');
 const road={type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:[[0,0],[20,0]] as [number,number][]},properties:{id:'main',name:null,highway:'primary',lanes:1,width:8,oneway:true,surface:'asphalt',sidewalk:false,bridge:false,tunnel:false,layer:0}};
 const crossing=(id:string,y:number)=>({type:'Feature' as const,geometry:{type:'Point' as const,coordinates:[10,y] as [number,number]},properties:{id,crossing:'uncontrolled'}});
 const one=buildRoads([road],[],[crossing('a',3)],(x,y)=>[x,-y],()=>0,{markings:true,bridges:false}).roads;
 const pair=buildRoads([road],[],[crossing('a',3),crossing('b',-3)],(x,y)=>[x,-y],()=>0,{markings:true,bridges:false}).roads;
 expect(pair.getAttribute('position').count).toBe(one.getAttribute('position').count);
});

it('paints a known right-side bus lane distinctly without moving the roadway',async()=>{
 const {buildRoads}=await import('./roads');
 const {hex}=await import('./props');
 const road={type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:[[0,0],[100,0]] as [number,number][]},properties:{id:'bus-road',name:'East Broad Street',highway:'primary',lanes:2,width:8,oneway:true,bus_lanes:1,bus_lane_side:'right' as const,surface:'asphalt',sidewalk:false,sidewalk_left:false,sidewalk_right:false,bridge:false,tunnel:false,layer:0}};
 const result=buildRoads([road],[],[],(x,y)=>[x,-y],()=>0,{markings:false});
 const color=result.roads.getAttribute('color'),pos=result.roads.getAttribute('position'),bus=hex('bus_lane');
 let painted=0;
 for(let i=0;i<color.count;i++) if(Math.abs(color.getX(i)-bus.r)<1e-6 && Math.abs(color.getY(i)-bus.g)<1e-6){
  painted++;expect(pos.getZ(i)).toBeGreaterThanOrEqual(-1e-6);expect(pos.getZ(i)).toBeLessThanOrEqual(4+1e-6);
 }
 expect(painted).toBeGreaterThan(0);
 expect(result.paths[0].every(p=>p.z===0)).toBe(true);
});

it('opens bridge railings at same-level junctions but keeps them over an underpass',async()=>{
 const {buildRoads}=await import('./roads');
 const countBlockedRails=(crossHeight:number)=>{
  const features=[{coords:[[0,0],[100,0]],height:20},{coords:[[50,-30],[50,30]],height:crossHeight}].map(({coords,height},i)=>({
   type:'Feature' as const,geometry:{type:'LineString' as const,coordinates:coords as [number,number][]},
   properties:{id:`way-${i}`,name:null,highway:'primary',lanes:2,width:8,oneway:false,surface:'asphalt',sidewalk:false,sidewalk_left:false,sidewalk_right:false,bridge:true,tunnel:false,layer:1,deck:[...coords[0],height,...coords[1],height]},
  }));
  const g=buildRoads(features,[],[],(x,y)=>[x,-y],()=>0,{markings:false}).roads;
  const p=g.getAttribute('position'),n=g.getAttribute('normal');let found=0;
  for(let i=0;i<p.count;i+=3){
   const x=(p.getX(i)+p.getX(i+1)+p.getX(i+2))/3;
   const y=(p.getY(i)+p.getY(i+1)+p.getY(i+2))/3;
   const z=(p.getZ(i)+p.getZ(i+1)+p.getZ(i+2))/3;
   if(Math.abs(x-50)<4.2 && Math.abs(z)<7 && y>20.88 && y<22 && Math.abs(n.getY(i))<0.1) found++;
  }
  return found;
 };
 expect(countBlockedRails(20)).toBe(0);
 expect(countBlockedRails(0)).toBeGreaterThan(0);
});
