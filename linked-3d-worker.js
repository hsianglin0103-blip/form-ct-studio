import { cleanVector } from './clean-vector.js';
self.onmessage=({data})=>{
  try {
    const {revision,pixels,w,h,settings}=data;
    const result=cleanVector(pixels,w,h,settings);
    self.postMessage({revision,svg:result.svg,stats:result.stats});
  } catch(error) { self.postMessage({revision:data.revision,error:error.message}); }
};
