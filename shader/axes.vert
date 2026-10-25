#version 300 es
precision highp float;

in vec4 a_lineStart;
in vec4 a_lineEnd;
in vec3 a_corner;
in vec3 a_axisColor;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform vec2 u_resolution;
uniform float u_lineWidth;
uniform bool u_drawEndpoint;
uniform float u_endpointSize;
uniform float u_endpointThreshold;
uniform float u_depthOffset;
uniform bool u_tetrahedralProjection;
uniform bool u_tesseractProjection;
uniform float u_wPerspectiveDistance;

out vec3 v_axisColor;
out float v_isEndpoint;

vec3 projectTetrahedral(vec4 point4D) {
    const float inverseRootThree = 0.57735026919;
    return inverseRootThree * vec3(
        point4D.x + point4D.y - point4D.z - point4D.w,
        point4D.x - point4D.y + point4D.z - point4D.w,
        point4D.x - point4D.y - point4D.z + point4D.w
    );
}

vec3 projectTesseract(vec4 point4D) {
    // Central projection from w=-d onto w=0; w=0 remains unchanged.
    float perspectiveScale = u_wPerspectiveDistance / (u_wPerspectiveDistance + point4D.w);
    return point4D.xyz * perspectiveScale;
}

vec3 projectPoint(vec4 point4D) {
    if (u_tetrahedralProjection) return projectTetrahedral(point4D);
    if (u_tesseractProjection) return projectTesseract(point4D);
    return point4D.xyz;
}

void main() {
    vec3 startPosition = projectPoint(a_lineStart);
    vec3 endPosition = projectPoint(a_lineEnd);
    vec4 startClip = u_projection * u_view * vec4(startPosition, 1.0);
    vec4 endClip = u_projection * u_view * vec4(endPosition, 1.0);
    vec2 startNdc = startClip.xy / startClip.w;
    vec2 endNdc = endClip.xy / endClip.w;

    // 画面上のピクセル座標で線の垂直方向を求める。
    vec2 directionPixels = (endNdc - startNdc) * u_resolution;
    float directionLength = length(directionPixels);

    if (u_drawEndpoint) {
        // 各軸の最後の頂点だけを使い、投影上短い軸の正方向端に丸い点を描く。
        if (a_corner.x >= 0.999 && directionLength < u_endpointThreshold) {
            gl_Position = endClip;
            gl_PointSize = u_endpointSize;
            v_axisColor = a_axisColor;
            v_isEndpoint = 1.0;
        } else {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 1.0;
            v_axisColor = a_axisColor;
            v_isEndpoint = 0.0;
        }
        return;
    }

    // 投影上ほぼ点になる軸は、三角形の帯・矢じりを描かない。
    if (directionLength < u_endpointThreshold) {
        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        gl_PointSize = 1.0;
        v_axisColor = a_axisColor;
        v_isEndpoint = 0.0;
        return;
    }
    vec2 perpendicular = directionLength > 1.0e-5
        ? vec2(-directionPixels.y, directionPixels.x) / directionLength
        : vec2(0.0, 1.0);
    vec2 direction = directionLength > 1.0e-5
        ? directionPixels / directionLength
        : vec2(1.0, 0.0);

    vec4 clipPosition = mix(startClip, endClip, a_corner.x);
    // NDCのオフセットをクリップ座標へ戻す。u_lineWidthは描画バッファ上のピクセル幅。
    vec2 offsetNdc = (perpendicular * a_corner.y * u_lineWidth
        + direction * a_corner.z * (u_lineWidth / 3.0)) / u_resolution;
    clipPosition.xy += offsetNdc * clipPosition.w;
    // A small negative clip-space Z offset keeps overlay curves visible on sampled surfaces.
    clipPosition.z -= u_depthOffset * clipPosition.w;
    gl_Position = clipPosition;
    gl_PointSize = 1.0;
    v_axisColor = a_axisColor;
    v_isEndpoint = 0.0;
}