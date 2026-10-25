#version 300 es
precision highp float;

in vec4 a_position;
uniform vec4 u_axisA;
uniform vec4 u_axisB;
uniform float u_angle;

out vec4 tf_position;

vec4 rotateInPlane(vec4 value) {
    float alpha = dot(value, u_axisA);
    float beta = dot(value, u_axisB);
    vec4 rest = value - alpha * u_axisA - beta * u_axisB;

    float rotatedAlpha = alpha * cos(u_angle) - beta * sin(u_angle);
    float rotatedBeta = alpha * sin(u_angle) + beta * cos(u_angle);
    return rotatedAlpha * u_axisA + rotatedBeta * u_axisB + rest;
}

void main() {
    // The axes are normalized in JavaScript from their current start-to-end vectors.
    tf_position = rotateInPlane(a_position);
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
}
