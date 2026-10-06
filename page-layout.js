const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export const PAGE_RATIOS={artwork:null,square:1,portrait_4_5:4/5,portrait_3_4:3/4,landscape_16_9:16/9,a4:210/297};

export function computePageLayout(artW,artH,settings={}){
  if(artW<1||artH<1)throw new Error('Invalid artwork dimensions.');
  const ratio=PAGE_RATIOS[settings.ratio]||artW/artH;
  const w=Math.round(clamp(Number(settings.width)||1600,400,3600));
  const h=Math.round(w/ratio);
  const fill=clamp(Number(settings.scale??100),25,100)/100;
  const scale=Math.min(w/artW,h/artH)*fill;
  const drawW=artW*scale,drawH=artH*scale;
  const horizontal=clamp(Number(settings.x)||0,-100,100)/100;
  const vertical=clamp(Number(settings.y)||0,-100,100)/100;
  const x=(w-drawW)/2*(1+horizontal);
  const y=(h-drawH)/2*(1+vertical);
  return {w,h,x,y,scale,drawW,drawH,artW,artH,ratio,background:settings.background||'#f2f6f0'};
}
