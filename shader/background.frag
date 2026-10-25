#version 300 es
precision highp float;

uniform float u_tileSize;
out vec4 outColor;

void main() {
    vec2 tile = floor(gl_FragCoord.xy / u_tileSize);
    float checker = mod(tile.x + tile.y, 2.0);
    vec3 color = mix(vec3(1.0), vec3(0.78), checker);
    outColor = vec4(color, 1.0);
}
