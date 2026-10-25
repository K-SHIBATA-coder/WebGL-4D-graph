#version 300 es
precision mediump float;

in vec3 v_axisColor;
in float v_isEndpoint;
out vec4 outColor;

void main() {
    if (v_isEndpoint > 0.5) {
        vec2 point = gl_PointCoord - vec2(0.5);
        if (dot(point, point) > 0.25) discard;
    }
    outColor = vec4(v_axisColor, 1.0);
}
