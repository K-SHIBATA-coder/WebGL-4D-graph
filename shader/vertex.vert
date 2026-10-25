#version 300 es
precision highp float;

in vec4 a_position;
in vec4 a_normal;
in float a_duplicateRank;
in float a_duplicateCount;
in float a_complexHue;
in float a_pointVisible;

uniform mat4 u_view;
uniform mat4 u_projection;
uniform float u_pointSize;
uniform vec3 u_displayHalfExtent;
uniform bool u_tetrahedralProjection;
uniform bool u_tesseractProjection;
uniform float u_wPerspectiveDistance;
uniform bool u_octahedralClip;

out vec3 v_normal;
out float v_w;
out float v_vectorMagnitude;
out float v_duplicateRank;
out float v_duplicateCount;
out float v_complexHue;
out float v_pointVisible;

vec3 projectTetrahedral(vec4 point4D) {
    const float inverseRootThree = 0.57735026919;
    // The four columns are the vertices of a regular tetrahedron centered at the origin.
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

void main() {
    vec3 displayPosition = a_position.xyz;
    if (u_tetrahedralProjection) {
        displayPosition = projectTetrahedral(a_position);
    } else if (u_tesseractProjection) {
        displayPosition = projectTesseract(a_position);
    }

    v_w = a_position.w;
    v_vectorMagnitude = length(a_position);
    v_normal = length(a_normal.xyz) > 1.0e-6 ? normalize(a_normal.xyz) : vec3(0.0);
    v_duplicateRank = a_duplicateRank;
    v_duplicateCount = a_duplicateCount;
    v_complexHue = a_complexHue;
    // The JSON sampler already restricts points to the selected 4D domain.
    // Do not clip again against a fixed projected cube/octahedron: the graph and
    // its 4D range frame rotate together, so that post-projection clip would stay behind.
    v_pointVisible = a_pointVisible;
    gl_Position = u_projection * u_view * vec4(displayPosition, 1.0);
    gl_PointSize = u_pointSize;
}