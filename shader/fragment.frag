#version 300 es
precision mediump float;

in vec3 v_normal;
in float v_w;
in float v_vectorMagnitude;
in float v_duplicateRank;
in float v_duplicateCount;
in float v_complexHue;
in float v_pointVisible;
out vec4 outColor;
uniform float u_duplicateStep;
uniform float u_wMin;
uniform float u_wMax;
uniform int u_boundaryOnly;
uniform int u_complexHueMode;
uniform int u_magnitudeColorMode;
uniform float u_magnitudePeriod;

// ===== COLOR MAPPING =====
// magnitudeColorModeは大きさを周期色相に割り当てます（u_magnitudePeriodごとに反復）。
// 位相/偏角の色相は周期量なので、この色相環を使います。
vec3 hsvToRgb(vec3 hsv) {
    float h = fract(hsv.x); // 色相を0〜1に折り返す
    float s = clamp(hsv.y, 0.0, 1.0);
    float v = clamp(hsv.z, 0.0, 1.0);
    vec3 rgb = clamp(
        abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0,
        0.0,
        1.0
    );
    return v * mix(vec3(1.0), rgb, s);
}

void main() {
    if (v_pointVisible < 0.5) discard;
    // 同じXYZ位置に重なる点は、時間に応じてグループ内の1点ずつ表示する。
    if (v_duplicateCount > 1.0) {
        float selectedRank = mod(u_duplicateStep, v_duplicateCount);
        if (abs(v_duplicateRank - selectedRank) > 0.25) discard;
    }
    vec2 point = gl_PointCoord - vec2(0.5);
    if (dot(point, point) > 0.25) discard;

    float t = v_w / 5.0;
    vec3 baseColor;
    if (u_magnitudeColorMode > 0) {
        // Both projection modes use the automatically scaled display range for one hue cycle.
        float period = max(u_magnitudePeriod, 1.0e-6);
        float magnitudeHue = mod(v_vectorMagnitude, period) / period;
        baseColor = hsvToRgb(vec3(magnitudeHue, 1.0, 1.0));
    } else if (u_complexHueMode == 1) {
        // 色相は出力複素数yの偏角arg(y)を0〜1周に対応させる。
        baseColor = hsvToRgb(vec3(v_complexHue, 1.0, 1.0));
    } else if (t > 0.0) {
        // 正のWは最小値を色相0（赤）、最大値を色相1（赤）に対応させる。
        float positiveHue = clamp((v_w - u_wMin) / max(u_wMax - u_wMin, 1.0e-6), 0.0, 1.0);
        baseColor = hsvToRgb(vec3(positiveHue, 1.0, 1.0));
    } else if (t < 0.0) {
        // 以前の負のWのグレースケール表示を再開する。
        baseColor = vec3(0.2 + 0.8 * mod(t, 1.0));
    } else {
        // W=0は黒。
        baseColor = vec3(0.0);
    }
    float normalLength = length(v_normal);
    // Scalar 4D level sets project to a 3D volume. Render only the points
    // identified on that volume's estimated exterior boundary.
    if (u_boundaryOnly == 1 && normalLength < 0.1) discard;
    const float minimumLight = 0.7;
    float diffuseLight = max(dot(normalize(v_normal), normalize(vec3(0.4,0.7,1.0))), 0.0);
    float light = normalLength < 0.1 ? minimumLight :
        minimumLight + (1.0 - minimumLight) * diffuseLight;
    outColor = vec4(baseColor * light, 1.0);
}
