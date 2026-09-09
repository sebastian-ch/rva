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
