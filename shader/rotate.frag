#version 300 es
precision highp float;

out vec4 outColor;

void main() {
    // 回転結果の取得専用。RASTERIZER_DISCARD中は画面に描かれない。
    outColor = vec4(0.0);
}
