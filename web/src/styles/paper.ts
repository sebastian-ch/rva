import { defineStyle } from './definition';

export default defineStyle({
  label: 'Folded Paper',
  theme: { bg: '#f0ebdf', alt: '#ffffff', border: '#cfc6b4', text: '#514b40', muted: '#817969', scheme: 'light' },
  fragment: /* glsl */ `
    vec3 paperNormal = faceNormal(vUv);
    vec3 paperColor = abs(paperNormal.y) > 0.75 ? vec3(1.0) :
      paperNormal.x + paperNormal.z * 0.3 > 0.0 ? vec3(0.941, 0.922, 0.875) : vec3(0.847, 0.812, 0.745);
    float paperLuma = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    if (abs(paperNormal.y) > 0.75 && paperLuma < 0.18) paperColor = vec3(0.847, 0.812, 0.745);
    float crease = 0.0;
    if (texture2D(tDepth, vUv).r < 0.99999) {
      crease = max(1.0-dot(paperNormal,faceNormal(vUv+vec2(px.x,0))),1.0-dot(paperNormal,faceNormal(vUv+vec2(0,px.y))));
    }
    float contact = max(step(1.0, d-depthM(vUv+vec2(2.0,-2.0)*px*uPixelRatio)) * (1.0-step(8.0,d-depthM(vUv+vec2(2.0,-2.0)*px*uPixelRatio))), 0.0);
    paperColor *= 1.0 - contact*0.18 - (1.0-ao)*0.3;
    paperColor = mix(paperColor,vec3(0.663,0.620,0.545),max(edge*0.55,smoothstep(0.3,0.9,crease)*0.5));
    if (texture2D(tDepth,vUv).r > 0.99999) paperColor=vec3(0.906,0.882,0.835);
    gl_FragColor=vec4(pow(paperColor,vec3(2.2)),color.a);
    return;
  `,
});
