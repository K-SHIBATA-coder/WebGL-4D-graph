"use strict";

const canvas = document.getElementById("glCanvas");
const status = document.getElementById("status");
const rotationAnglesDisplay = document.getElementById("rotationAngles");
const isZetaData = new URLSearchParams(window.location.search).get("dataset") === "zeta";
const datasetToggleButton = document.getElementById("datasetToggle");
// ===== UI WIRING: HTML上の操作部品との接続 =====
const colorDisplayButton = document.getElementById("colorDisplayButton");
const logArgDisplayButton = document.getElementById("logArgDisplayButton");
const tetrahedralDisplayButton = document.getElementById("tetrahedralDisplayButton");
const tesseractDisplayButton = document.getElementById("tesseractDisplayButton");
const flatLogArgToggleButton = document.getElementById("flatLogArgToggleButton");
const logArgSwapButton = document.getElementById("logArgSwapButton");
const displayModeDescription = document.getElementById("displayModeDescription");
const displayParams = new URLSearchParams(window.location.search);
const savedDisplayMode = displayParams.get("renderMode");
// Legacy URLs that contain both modes prefer log・arg so the two projections never combine.
const requestedDisplayMode = ["color", "logarg", "tetrahedral", "tesseract"].includes(savedDisplayMode)
    ? savedDisplayMode
    : displayParams.get("complexView") === "logpolar"
        ? "logarg"
        : displayParams.get("projection") === "tetrahedral" ? "tetrahedral" : "color";
const requestedComplexLogPolarView = requestedDisplayMode === "logarg";
const requestedFlatLogArgView = requestedComplexLogPolarView && displayParams.get("logArgFlat") === "1";
const requestedLogArgSwap = requestedComplexLogPolarView && displayParams.get("logArgSwap") === "1";
const requestedTetrahedralProjection = requestedDisplayMode === "tetrahedral";
const requestedTesseractProjection = requestedDisplayMode === "tesseract";
function navigateToDisplayMode(mode) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("renderMode", mode);
    nextUrl.searchParams.delete("complexView");
    nextUrl.searchParams.delete("projection");
    if (mode !== "logarg") {
        nextUrl.searchParams.delete("logArgFlat");
        nextUrl.searchParams.delete("logArgSwap");
    }
    window.location.assign(nextUrl.href);
}
function updateLogArgOption(parameter, enabled) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("renderMode", "logarg");
    if (enabled) nextUrl.searchParams.set(parameter, "1");
    else nextUrl.searchParams.delete(parameter);
    window.location.assign(nextUrl.href);
}
colorDisplayButton.addEventListener("click", () => navigateToDisplayMode("color"));
logArgDisplayButton.addEventListener("click", () => navigateToDisplayMode("logarg"));
tetrahedralDisplayButton.addEventListener("click", () => navigateToDisplayMode("tetrahedral"));
tesseractDisplayButton.addEventListener("click", () => navigateToDisplayMode("tesseract"));
flatLogArgToggleButton.addEventListener("click", () =>
    updateLogArgOption("logArgFlat", !requestedFlatLogArgView));
logArgSwapButton.addEventListener("click", () =>
    updateLogArgOption("logArgSwap", !requestedLogArgSwap));
const gl = canvas.getContext("webgl2");

datasetToggleButton.textContent = isZetaData
    ? "通常の方程式を表示"
    : "リーマンゼータ関数を表示";
datasetToggleButton.addEventListener("click", () => {
    const nextUrl = new URL(window.location.href);
    if (isZetaData) {
        nextUrl.searchParams.delete("dataset");
    } else {
        nextUrl.searchParams.set("dataset", "zeta");
    }
    window.location.assign(nextUrl.href);
});

if (gl === null) {
    alert("WebGL2が使えません");
    throw new Error("WebGL2 not supported");
}

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error(gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl, vertexShader, fragmentShader, feedbackVaryings = null) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    if (feedbackVaryings !== null) {
        gl.transformFeedbackVaryings(program, feedbackVaryings, gl.INTERLEAVED_ATTRIBS);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error(gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

async function loadTextFile(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path} を読み込めません (${response.status})`);
    return response.text();
}

// ===== DISPLAY SETTINGS: 投影画角・回転平面順 =====
// 投影画角や回転UIの順序を調整するときに確認してください。
const TWO_PI = 2.0 * Math.PI;
// 点群の大きさに合わせてカメラ距離と奥行き範囲を自動調整する。
const FIELD_OF_VIEW = 12.0 * Math.PI / 180.0;
const ROTATION_PLANES = ["XY", "YZ", "XZ", "XW", "YW", "ZW"];
const COMPLEMENTARY_PLANES = {XY:"ZW", ZW:"XY", YZ:"XW", XW:"YZ", XZ:"YW", YW:"XZ"};
const rotationAngles = {XY:0, YZ:0, XZ:0, XW:0, YW:0, ZW:0};

function updateRotationAnglesDisplay() {
    rotationAnglesDisplay.textContent = ROTATION_PLANES
        .map(plane => `${plane} ${rotationAngles[plane].toFixed(3)}`)
        .join(" · ");
}

function makePerspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2.0);
    const nf = 1.0 / (near - far);
    return new Float32Array([
        f/aspect,0,0,0, 0,f,0,0,
        0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0
    ]);
}

function makeView(yaw, pitch, center, cameraDistance) {
    // Use Z as the world-up axis. The camera orbits above the XY plane so X
    // points mostly right, Y points into depth, and Z points mostly upward.
    const cosYaw = Math.cos(yaw), sinYaw = Math.sin(yaw);
    // The yaw basis also defines stable screen-right/up directions at either pole.
    const elevation = Math.max(-Math.PI / 2.0, Math.min(Math.PI / 2.0, pitch));
    const cosElevation = Math.cos(elevation), sinElevation = Math.sin(elevation);
    const [cx, cy, cz] = center;

    const right = [cosYaw, sinYaw, 0.0];
    const up = [-sinElevation * sinYaw, sinElevation * cosYaw, cosElevation];
    const back = [cosElevation * sinYaw, -cosElevation * cosYaw, sinElevation];
    const translatedX = -(right[0] * cx + right[1] * cy + right[2] * cz);
    const translatedY = -(up[0] * cx + up[1] * cy + up[2] * cz);
    const translatedZ = -(back[0] * cx + back[1] * cy + back[2] * cz) - cameraDistance;

    // WebGL matrices are column-major; right, up, and back form the view rows.
    return new Float32Array([
        right[0], up[0], back[0], 0.0,
        right[1], up[1], back[1], 0.0,
        right[2], up[2], back[2], 0.0,
        translatedX, translatedY, translatedZ, 1.0
    ]);
}


async function loadPointCloud(metadataFile) {
    const metadataResponse = await fetch(metadataFile);
    if (!metadataResponse.ok) {
        const generator = metadataFile.startsWith("zeta_") ? "4D_zeta_generate.py" : "4D_generate.py";
        throw new Error(`${metadataFile} を読み込めません。先に ${generator} を実行してください。`);
    }
    const data = await metadataResponse.json();

    if (data.binary) {
        if (data.dataFormat !== "4d-point-cloud-binary-v1" || data.binary.byteOrder !== "little-endian") {
            throw new Error("点群バイナリの形式が未対応です。Python生成コードを更新して再生成してください。");
        }
        const binaryResponse = await fetch(data.binary.file);
        if (!binaryResponse.ok) {
            throw new Error(`${data.binary.file} を読み込めません。点群生成器を再実行してください。`);
        }
        const buffer = await binaryResponse.arrayBuffer();
        const pointCount = Number(data.binary.pointCount);
        const criticalLineCount = Number(data.binary.criticalLineCount || 0);
        const floatView = (offset, count) => {
            if (offset % 4 !== 0 || offset + count * 4 > buffer.byteLength) {
                throw new Error("点群バイナリの位置情報が不正です。");
            }
            if (new Uint8Array(new Uint32Array([1]).buffer)[0] === 1) {
                return new Float32Array(buffer, offset, count);
            }
            const values = new Float32Array(count);
            const view = new DataView(buffer);
            for (let i = 0; i < count; i++) values[i] = view.getFloat32(offset + i * 4, true);
            return values;
        };
        const validityOffset = Number(data.binary.validityOffset);
        if (validityOffset + pointCount > buffer.byteLength) {
            throw new Error("点群バイナリの有効点フラグが不正です。");
        }
        data.pointCount = pointCount;
        data.criticalLineCount = criticalLineCount;
        data.positions = floatView(Number(data.binary.positionsOffset), pointCount * 4);
        data.normals = floatView(Number(data.binary.normalsOffset), pointCount * 4);
        data.validity = new Uint8Array(buffer, validityOffset, pointCount);
        data.criticalLinePositions = floatView(Number(data.binary.criticalLineOffset), criticalLineCount * 4);
        return data;
    }

    // Read older JSON point files as well, so the app still works before regeneration.
    const points = Array.isArray(data.points) ? data.points : [];
    const lines = Array.isArray(data.criticalLine) ? data.criticalLine : [];
    data.pointCount = points.length;
    data.criticalLineCount = lines.length;
    data.positions = new Float32Array(points.length * 4);
    data.normals = new Float32Array(points.length * 4);
    data.validity = new Uint8Array(points.length);
    data.criticalLinePositions = new Float32Array(lines.length * 4);
    points.forEach((point, index) => {
        const position = point.position || point;
        const normal = point.normal || [0, 0, 0, 0];
        data.positions.set(position, index * 4);
        data.normals.set(normal, index * 4);
        data.validity[index] = point.valid === false ? 0 : 1;
    });
    lines.forEach((point, index) => data.criticalLinePositions.set(point, index * 4));
    delete data.points;
    delete data.criticalLine;
    return data;
}
async function main() {
    const dataFile = isZetaData ? "zeta_points.json" : "data.json";
    const [vertexSource, fragmentSource, rotateVertexSource, rotateFragmentSource,
        backgroundVertexSource, backgroundFragmentSource, axesVertexSource, axesFragmentSource,
        data] = await Promise.all([
        loadTextFile("shader/vertex.vert"),
        loadTextFile("shader/fragment.frag"),
        loadTextFile("shader/rotate.vert"),
        loadTextFile("shader/rotate.frag"),
        loadTextFile("shader/background.vert"),
        loadTextFile("shader/background.frag"),
        loadTextFile("shader/axes.vert"),
        loadTextFile("shader/axes.frag"),
        loadPointCloud(dataFile)
    ]);

    const isComplexEquationData = data.mode === "complex" || data.equationKind === "complex-implicit";
    const canUseComplexView = data.mode === "complex" ||
        (data.equationKind === "complex-implicit" &&
            ["z", "w"].every(symbol => data.activeVariables?.includes(symbol)));
    const useComplexLogPolarView = canUseComplexView && requestedComplexLogPolarView;
    const isFlatLogArgView = useComplexLogPolarView && requestedFlatLogArgView;
    // Zeta input coordinates are stored in display-scaled sigma/t units; keep its
    // established input parametrization instead of pretending those are raw s values.
    const useLogArgSwap = useComplexLogPolarView && !isZetaData && requestedLogArgSwap;
    const activeDisplayMode = useComplexLogPolarView
        ? "logarg"
        : requestedTetrahedralProjection
            ? "tetrahedral"
            : requestedTesseractProjection ? "tesseract" : "color";
    colorDisplayButton.disabled = activeDisplayMode === "color";
    logArgDisplayButton.disabled = !canUseComplexView || activeDisplayMode === "logarg";
    tetrahedralDisplayButton.disabled = activeDisplayMode === "tetrahedral";
    tesseractDisplayButton.disabled = activeDisplayMode === "tesseract";
    flatLogArgToggleButton.hidden = !useComplexLogPolarView;
    flatLogArgToggleButton.textContent = isFlatLogArgView ? "立体log・arg表示に戻す" : "高さ0の色付き平面にする";
    flatLogArgToggleButton.setAttribute("aria-pressed", isFlatLogArgView ? "true" : "false");
    logArgSwapButton.hidden = !useComplexLogPolarView || isZetaData;
    logArgSwapButton.textContent = useLogArgSwap ? "入力を横軸に戻す" : "入力と出力を入れ替える";
    logArgSwapButton.setAttribute("aria-pressed", useLogArgSwap ? "true" : "false");
    document.getElementById("resetRotation").disabled = isFlatLogArgView;
    document.getElementById("resetCamera").disabled = isFlatLogArgView;
    logArgDisplayButton.title = canUseComplexView
        ? "複素出力z+wiのlog|z+wi|を高さ、arg(z+wi)を色相にします。"
        : "log・arg表示は複素方程式・ゼータ関数でのみ選択できます。";
    displayModeDescription.textContent = activeDisplayMode === "logarg"
        ? isFlatLogArgView
            ? useLogArgSwap
                ? "高さ0の色付き平面: 座標=(Re(y), Im(y), 0)、色相=arg(x)。4D回転・カメラ回転・照明は停止します。"
                : isZetaData
                    ? "高さ0の色付き平面: 座標=(σ, t, 0)、色相=arg(ζ(s))。4D回転・カメラ回転・照明は停止します。"
                    : "高さ0の色付き平面: 座標=(Re(x), Im(x), 0)、色相=arg(y)。4D回転・カメラ回転・照明は停止します。"
            : useLogArgSwap
                ? "log・arg表示（入出力反転）: 座標=(Re(y), Im(y), log|x|)、色相=arg(x)。"
                : isZetaData
                    ? "log・arg表示: 座標=(σ, t, log|ζ(s)|)、色相=arg(ζ(s))。"
                    : "log・arg表示: 座標=(Re(x), Im(x), log|y|)、色相=arg(y)。"
        : activeDisplayMode === "tetrahedral"
            ? "正四面体型: XYZW軸を正四面体の頂点方向へ投影し、枠は正八面体、色は4Dベクトル長（5ごとに反復）です。"
            : activeDisplayMode === "tesseract"
                ? "正八胞体型: w=0の外側の立方体と、w方向の中心投影で内側へ縮む立方体を辺で結びます。色は4Dベクトル長に対応し、色相周期は表示範囲から自動設定されます。"
                : "色を使った表示: 通常の4D投影と、W座標に応じた色で表示します。";

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const rotateVertexShader = createShader(gl, gl.VERTEX_SHADER, rotateVertexSource);
    const rotateFragmentShader = createShader(gl, gl.FRAGMENT_SHADER, rotateFragmentSource);
    const backgroundVertexShader = createShader(gl, gl.VERTEX_SHADER, backgroundVertexSource);
    const backgroundFragmentShader = createShader(gl, gl.FRAGMENT_SHADER, backgroundFragmentSource);
    const axesVertexShader = createShader(gl, gl.VERTEX_SHADER, axesVertexSource);
    const axesFragmentShader = createShader(gl, gl.FRAGMENT_SHADER, axesFragmentSource);
    if (!vertexShader || !fragmentShader || !rotateVertexShader || !rotateFragmentShader ||
        !backgroundVertexShader || !backgroundFragmentShader || !axesVertexShader || !axesFragmentShader) return;

    const renderProgram = createProgram(gl, vertexShader, fragmentShader);
    const rotationProgram = createProgram(
        gl, rotateVertexShader, rotateFragmentShader, ["tf_position"]
    );
    const backgroundProgram = createProgram(gl, backgroundVertexShader, backgroundFragmentShader);
    const axesProgram = createProgram(gl, axesVertexShader, axesFragmentShader);
    if (!renderProgram || !rotationProgram || !backgroundProgram || !axesProgram) return;

const pointCount = data.pointCount;
    const declaredGridSteps = Number(data.gridSteps);
    const samplingSteps = Number.isFinite(declaredGridSteps) && declaredGridSteps > 0
        ? declaredGridSteps
        : Math.max(1, Math.round(Math.sqrt(pointCount)) - 1);
    // Use 12px at 64 divisions; finer grids get proportionally smaller points.
    const pointSizePixels = Math.min(12.0, Math.max(0.75, 12.0 * 64.0 / samplingSteps));
    const axisCount = 4;
    const criticalLinePositions = data.criticalLinePositions;
    const criticalLinePointCount = data.criticalLineCount;
    const criticalLineStartIndex = pointCount + axisCount * 2;
    const stationaryPoints = Array.isArray(data.stationaryPoints) ? data.stationaryPoints : [];
    const stationaryPointCount = stationaryPoints.length;
    const stationaryStartIndex = criticalLineStartIndex + criticalLinePointCount;
    const boundPairs = data.bounds && data.bounds.length >= 4
        ? [[data.bounds[0], data.bounds[1]], [data.bounds[2], data.bounds[3]]]
        : data.bounds ? [[data.bounds[0], data.bounds[1]]] : [[-5.0, 5.0]];
    const domainHalfExtent = Math.max(0.0, ...boundPairs.map(([min, max]) => Math.abs(max - min) / 2.0));
    // Keep zeta output direction (phase) while compressing its enormous magnitude range.
    let zetaOutputLogScale = 1.0;
    if (data.generator === "riemann-zeta") {
        let maximumLogMagnitude = 0.0;
        const includeLogMagnitude = (real, imaginary) => {
            maximumLogMagnitude = Math.max(maximumLogMagnitude, Math.log1p(Math.hypot(real, imaginary)));
        };
        for (let i = 0; i < pointCount; i++) {
            if (data.validity[i] === 0) continue;
            includeLogMagnitude(data.positions[i * 4 + 2], data.positions[i * 4 + 3]);
        }
        for (let i = 0; i < criticalLinePointCount; i++) {
            includeLogMagnitude(criticalLinePositions[i * 4 + 2], criticalLinePositions[i * 4 + 3]);
        }
        if (maximumLogMagnitude > 1.0e-12) {
            zetaOutputLogScale = domainHalfExtent / maximumLogMagnitude;
        }
    }
    function displayZetaOutput(real, imaginary) {
        const magnitude = Math.hypot(real, imaginary);
        if (magnitude < 1.0e-12) return [0.0, 0.0];
        const displayedMagnitude = Math.log1p(magnitude) * zetaOutputLogScale;
        return [real / magnitude * displayedMagnitude, imaginary / magnitude * displayedMagnitude];
    }

    // Use a robust reference magnitude and smooth radial compression for complex outputs.
    // A few samples next to poles can be enormous; scaling by the absolute maximum
    // would otherwise flatten the rest of the graph. The 95th percentile sets the
    // useful scale, while tanh keeps every finite output inside the display range.
    let complexOutputReferenceMagnitude = 1.0;
    const useComplexOutputCompression = data.mode === "complex" &&
        data.generator === "equation" && !useComplexLogPolarView;
    if (useComplexOutputCompression) {
        const outputMagnitudes = [];
        for (let i = 0; i < pointCount; i++) {
            if (data.validity[i] === 0) continue;
            const offset = i * 4;
            outputMagnitudes.push(Math.hypot(data.positions[offset + 2], data.positions[offset + 3]));
        }
        if (outputMagnitudes.length > 0) {
            outputMagnitudes.sort((a, b) => a - b);
            const percentileIndex = Math.floor((outputMagnitudes.length - 1) * 0.95);
            const percentileMagnitude = outputMagnitudes[percentileIndex];
            if (percentileMagnitude > 1.0e-12) {
                complexOutputReferenceMagnitude = percentileMagnitude / Math.atanh(0.95);
            }
        }
    }
    function displayComplexOutput(real, imaginary) {
        const magnitude = Math.hypot(real, imaginary);
        if (magnitude < 1.0e-12) return [0.0, 0.0];
        const displayedMagnitude = domainHalfExtent * Math.tanh(
            magnitude / complexOutputReferenceMagnitude
        );
        return [real / magnitude * displayedMagnitude, imaginary / magnitude * displayedMagnitude];
    }
    // Keep the camera and frame scaled to the input x/y bounds in log-arg view.
    // The transformed log-magnitude is a height value and must not resize the scene.
    let displayDomainHalfExtent = domainHalfExtent;
    if (useComplexLogPolarView) {
        // In log-arg space, size the square frame from its two visible plane axes,
        // not from the log-height or the unscaled sigma/t metadata.
        displayDomainHalfExtent = 0.0;
        for (let i = 0; i < pointCount; i++) {
            if (data.validity[i] === 0) continue;
            const offset = i * 4;
            const planeX = useLogArgSwap ? data.positions[offset + 2] : data.positions[offset];
            const planeY = useLogArgSwap ? data.positions[offset + 3] : data.positions[offset + 1];
            displayDomainHalfExtent = Math.max(displayDomainHalfExtent, Math.abs(planeX), Math.abs(planeY));
        }
        displayDomainHalfExtent = Math.max(displayDomainHalfExtent, 1.0e-5);
    }
    // 軸は自動縮尺後の表示範囲に比例させる。
    const axisHalfLength = Math.max(displayDomainHalfExtent * 1.25 * (requestedTetrahedralProjection ? Math.sqrt(3.0) : 1.0), 1.0e-6);
    const axisPositions = new Float32Array([
        -axisHalfLength,0,0,0, axisHalfLength,0,0,0,
        0,-axisHalfLength,0,0, 0,axisHalfLength,0,0,
        0,0,-axisHalfLength,0, 0,0,axisHalfLength,0,
        0,0,0,-axisHalfLength, 0,0,0,axisHalfLength
    ]);
    const axisColors = new Float32Array([
        1,0.15,0.15,
        0.15,1,0.25,
        0.2,0.45,1,
        0.8,0.25,0.95
    ]);

    // 点群と座標軸を同じ配列に置き、回転時に一度のTransform Feedbackで更新する。
    const vertexCount = stationaryStartIndex + stationaryPointCount;
    const currentPositions = new Float32Array(vertexCount * 4);
    const currentNormals = new Float32Array(vertexCount * 4);
    const complexHueValues = new Float32Array(pointCount);
    const pointVisibility = new Float32Array(pointCount);
    for (let i = 0; i < pointCount; i++) {
        const sourceOffset = i * 4;
        const x = data.positions[sourceOffset];
        const y = data.positions[sourceOffset + 1];
        const real = data.positions[sourceOffset + 2];
        const imaginary = data.positions[sourceOffset + 3];
        const pointIsValid = data.validity[i] !== 0;
        pointVisibility[i] = pointIsValid ? 1.0 : 0.0;
        if (!pointIsValid) {
            // Keep the parameter-grid location finite while hiding singular samples.
            currentPositions.set([x, y, 0.0, 0.0], sourceOffset);
        } else if (useComplexLogPolarView) {
            const inputMagnitude = Math.hypot(x, y);
            const outputMagnitude = Math.hypot(real, imaginary);
            const planeX = useLogArgSwap ? real : x;
            const planeY = useLogArgSwap ? imaginary : y;
            const logHeight = isFlatLogArgView ? 0.0 : Math.log(Math.max(
                useLogArgSwap ? inputMagnitude : outputMagnitude, 1.0e-3
            ));
            currentPositions.set([planeX, planeY, logHeight, 0.0], sourceOffset);
        } else if (useComplexOutputCompression) {
            const displayedOutput = displayComplexOutput(real, imaginary);
            currentPositions.set([x, y, displayedOutput[0], displayedOutput[1]], sourceOffset);
        } else if (data.generator === "riemann-zeta") {
            const displayedOutput = displayZetaOutput(real, imaginary);
            currentPositions.set([x, y, displayedOutput[0], displayedOutput[1]], sourceOffset);
        } else {
            currentPositions[sourceOffset] = x;
            currentPositions[sourceOffset + 1] = y;
            currentPositions[sourceOffset + 2] = real;
            currentPositions[sourceOffset + 3] = imaginary;
        }
        const hueReal = useLogArgSwap ? x : real;
        const hueImaginary = useLogArgSwap ? y : imaginary;
        const hueMagnitude = Math.hypot(hueReal, hueImaginary);
        const argument = hueMagnitude > 1.0e-12 ? Math.atan2(hueImaginary, hueReal) : 0.0;
        complexHueValues[i] = ((argument / TWO_PI) % 1.0 + 1.0) % 1.0;
        currentNormals[sourceOffset] = data.normals[sourceOffset];
        currentNormals[sourceOffset + 1] = data.normals[sourceOffset + 1];
        currentNormals[sourceOffset + 2] = data.normals[sourceOffset + 2];
        currentNormals[sourceOffset + 3] = data.normals[sourceOffset + 3];
    }
    currentPositions.set(axisPositions, pointCount * 4);
    if (criticalLinePointCount > 0) {
        const displayedCriticalLine = new Float32Array(criticalLinePointCount * 4);
        for (let i = 0; i < criticalLinePointCount; i++) {
            const offset = i * 4;
            const x = criticalLinePositions[offset];
            const y = criticalLinePositions[offset + 1];
            const real = criticalLinePositions[offset + 2];
            const imaginary = criticalLinePositions[offset + 3];
            if (useComplexLogPolarView) {
                const planeX = useLogArgSwap ? real : x;
                const planeY = useLogArgSwap ? imaginary : y;
                const logHeight = isFlatLogArgView ? 0.0 : Math.log(Math.max(
                    useLogArgSwap ? Math.hypot(x, y) : Math.hypot(real, imaginary), 1.0e-3
                ));
                displayedCriticalLine.set([planeX, planeY, logHeight, 0.0], offset);
            } else if (data.generator === "riemann-zeta") {
                const output = displayZetaOutput(real, imaginary);
                displayedCriticalLine.set([x, y, output[0], output[1]], offset);
            } else {
                displayedCriticalLine.set(criticalLinePositions.subarray(offset, offset + 4), offset);
            }
        }
        currentPositions.set(displayedCriticalLine, criticalLineStartIndex * 4);
    }
    for (let i = 0; i < stationaryPointCount; i++) {
        const [x, y, real, imaginary] = stationaryPoints[i];
        const offset = (stationaryStartIndex + i) * 4;
        if (useComplexLogPolarView) {
            const planeX = useLogArgSwap ? real : x;
            const planeY = useLogArgSwap ? imaginary : y;
            const logHeight = isFlatLogArgView ? 0.0 : Math.log(Math.max(
                useLogArgSwap ? Math.hypot(x, y) : Math.hypot(real, imaginary), 1.0e-3
            ));
            currentPositions.set([planeX, planeY, logHeight, 0.0], offset);
        } else if (useComplexOutputCompression) {
            const displayedOutput = displayComplexOutput(real, imaginary);
            currentPositions.set([x, y, displayedOutput[0], displayedOutput[1]], offset);
        } else {
            currentPositions.set([x, y, real, imaginary], offset);
        }
    }

    // The visible XYZ range follows the requested graph bounds (normally [-5, 5]),
    // not the larger 4D distance from the origin. Points are clipped to the current frame.
    const cubeHalfExtent = Math.max(displayDomainHalfExtent, 1.0e-5);
    // Match the octahedron's face distance to the data range, as the cube does.
    // For a regular octahedron, vertex radius = face distance * sqrt(3).
    const octahedronFaceDistance = cubeHalfExtent;
    const octahedronVertexRadius = octahedronFaceDistance * Math.sqrt(3.0);
    const displayHalfExtent = requestedTetrahedralProjection
        ? octahedronVertexRadius
        : cubeHalfExtent;
    const displayBoxHalfExtents = new Float32Array([
        displayHalfExtent, displayHalfExtent, displayHalfExtent
    ]);
    let maximumPointRadius4D = 0.0;
    for (let i = 0; i < pointCount; i++) {
        const offset = i * 4;
        maximumPointRadius4D = Math.max(maximumPointRadius4D, Math.hypot(
            currentPositions[offset], currentPositions[offset + 1],
            currentPositions[offset + 2], currentPositions[offset + 3]
        ));
    }
    // The perspective distance stays beyond every sampled W value, avoiding a pole.
    // The tesseract frame is centered at the 4D origin: its two cubes sit at w=-R and w=+R.
    const maximumFrameRadius4D = 2.0 * cubeHalfExtent;
    // A longer camera distance weakens W-perspective and keeps the projected frame close to [-R, R].
    const wPerspectiveDistance = Math.max(8.0 * cubeHalfExtent, maximumPointRadius4D, maximumFrameRadius4D) * 1.1;
    // The frame must use the same 4D bounds as the sampled graph to enclose it after rotation.
    const frameHalfExtent = cubeHalfExtent;
    const sceneRadius = isFlatLogArgView
        ? Math.sqrt(2.0) * cubeHalfExtent
        : requestedTetrahedralProjection
        ? 2.0 * cubeHalfExtent
        : requestedTesseractProjection
            ? Math.sqrt(3.0) * cubeHalfExtent * wPerspectiveDistance / (wPerspectiveDistance - cubeHalfExtent)
            : Math.sqrt(3.0) * cubeHalfExtent;
    const renderSceneCenter = new Float32Array([0.0, 0.0, 0.0]);

    function projectedComplexNormals(positions, branchMatchPositions = positions) {
        const [width, height] = data.gridShape || [0, 0];
        const branchCount = Math.max(1, Number(data.gridBranchCount) || 1);
        const normals = new Float32Array(vertexCount * 4);
        const branchSize = width * height;
        if (branchSize * branchCount !== pointCount || width < 2 || height < 2) return normals;

        const pointIndexAt = (branch, x, y) => branch * branchSize + x * height + y;
        const positionAt = (index, axis) => positions[index * 4 + axis];
        // Root labels from a principal complex power jump at its argument cut.
        // Match each neighboring sample to the closest 4D root instead of assuming
        // that it has the same branch number as the center point.
        const nearestRootAt = (x, y, centerIndex) => {
            let nearestIndex = -1;
            let nearestDistanceSquared = Infinity;
            for (let branch = 0; branch < branchCount; branch++) {
                const candidateIndex = pointIndexAt(branch, x, y);
                if (pointVisibility[candidateIndex] < 0.5) continue;
                let distanceSquared = 0.0;
                for (let axis = 0; axis < 4; axis++) {
                    const difference = branchMatchPositions[candidateIndex * 4 + axis] -
                        branchMatchPositions[centerIndex * 4 + axis];
                    distanceSquared += difference * difference;
                }
                if (distanceSquared < nearestDistanceSquared) {
                    nearestDistanceSquared = distanceSquared;
                    nearestIndex = candidateIndex;
                }
            }
            return nearestIndex;
        };

        for (let branch = 0; branch < branchCount; branch++) {
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const pointIndex = pointIndexAt(branch, x, y);
                    if (pointVisibility[pointIndex] < 0.5) continue;
                    const x0 = nearestRootAt(Math.max(0, x - 1), y, pointIndex);
                    const x1 = nearestRootAt(Math.min(width - 1, x + 1), y, pointIndex);
                    const y0 = nearestRootAt(x, Math.max(0, y - 1), pointIndex);
                    const y1 = nearestRootAt(x, Math.min(height - 1, y + 1), pointIndex);
                    if (x0 < 0 || x1 < 0 || y0 < 0 || y1 < 0) continue;

                    const tx = [0, 0, 0], ty = [0, 0, 0];
                    for (let axis = 0; axis < 3; axis++) {
                        tx[axis] = positionAt(x1, axis) - positionAt(x0, axis);
                        ty[axis] = positionAt(y1, axis) - positionAt(y0, axis);
                    }
                    const nx = tx[1] * ty[2] - tx[2] * ty[1];
                    const ny = tx[2] * ty[0] - tx[0] * ty[2];
                    const nz = tx[0] * ty[1] - tx[1] * ty[0];
                    const length = Math.hypot(nx, ny, nz);
                    if (length > 1.0e-10) {
                        const offset = pointIndex * 4;
                        normals[offset] = nx / length;
                        normals[offset + 1] = ny / length;
                        normals[offset + 2] = nz / length;
                    }
                }
            }
        }
        return normals;
    }

    function projectedBoundaryNormals(positions) {
        // The projection of a 4D scalar level set can fill a 3D volume. Estimate
        // its visible outer boundary by voxelizing the projected XYZ point cloud,
        // then use the outward density gradient as a boundary normal.
        const normals = new Float32Array(vertexCount * 4);
        const resolution = 36;
        const cellCount = resolution * resolution * resolution;
        const occupied = new Uint8Array(cellCount);
        const minimum = [Infinity, Infinity, Infinity];
        const maximum = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pointCount; i++) {
            const offset = i * 4;
            for (let axis = 0; axis < 3; axis++) {
                minimum[axis] = Math.min(minimum[axis], positions[offset + axis]);
                maximum[axis] = Math.max(maximum[axis], positions[offset + axis]);
            }
        }
        const span = maximum.map((value, axis) => Math.max(value - minimum[axis], 1.0e-6));
        // Leave an empty voxel margin so points on the bounding box have an outside.
        const cellFor = (value, axis) => Math.max(1, Math.min(resolution - 2,
            1 + Math.floor((value - minimum[axis]) / span[axis] * (resolution - 3))));
        const cellCoordinates = new Int16Array(pointCount * 3);
        const flatten = (x, y, z) => (z * resolution + y) * resolution + x;
        for (let i = 0; i < pointCount; i++) {
            const offset = i * 4;
            const x = cellFor(positions[offset], 0);
            const y = cellFor(positions[offset + 1], 1);
            const z = cellFor(positions[offset + 2], 2);
            cellCoordinates.set([x, y, z], i * 3);
            occupied[flatten(x, y, z)] = 1;
        }

        // A 3x3x3 local occupancy count smooths sampling gaps in the point cloud.
        const density = new Uint8Array(cellCount);
        for (let z = 1; z < resolution - 1; z++) {
            for (let y = 1; y < resolution - 1; y++) {
                for (let x = 1; x < resolution - 1; x++) {
                    let count = 0;
                    for (let dz = -1; dz <= 1; dz++)
                        for (let dy = -1; dy <= 1; dy++)
                            for (let dx = -1; dx <= 1; dx++)
                                count += occupied[flatten(x + dx, y + dy, z + dz)];
                    density[flatten(x, y, z)] = count;
                }
            }
        }
        for (let i = 0; i < pointCount; i++) {
            const x = cellCoordinates[i * 3];
            const y = cellCoordinates[i * 3 + 1];
            const z = cellCoordinates[i * 3 + 2];
            // Density rises toward the point-cloud interior; reverse its gradient
            // to orient the normal outward.
            const nx = density[flatten(x - 1, y, z)] - density[flatten(x + 1, y, z)];
            const ny = density[flatten(x, y - 1, z)] - density[flatten(x, y + 1, z)];
            const nz = density[flatten(x, y, z - 1)] - density[flatten(x, y, z + 1)];
            const length = Math.hypot(nx, ny, nz);
            if (length > 0.5) {
                const offset = i * 4;
                normals[offset] = nx / length;
                normals[offset + 1] = ny / length;
                normals[offset + 2] = nz / length;
            }
        }
        return normals;
    }

    function projectPositionsForNormals(positions) {
        const projected = new Float32Array(positions.length);
        const inverseRootThree = 1.0 / Math.sqrt(3.0);
        for (let i = 0; i < vertexCount; i++) {
            const offset = i * 4;
            const x = positions[offset], y = positions[offset + 1];
            const z = positions[offset + 2], w = positions[offset + 3];
            if (requestedTetrahedralProjection) {
                projected[offset] = (x + y - z - w) * inverseRootThree;
                projected[offset + 1] = (x - y + z - w) * inverseRootThree;
                projected[offset + 2] = (x - y - z + w) * inverseRootThree;
            } else {
                const perspectiveScale = wPerspectiveDistance / (wPerspectiveDistance + w);
                projected[offset] = x * perspectiveScale;
                projected[offset + 1] = y * perspectiveScale;
                projected[offset + 2] = z * perspectiveScale;
            }
            projected[offset + 3] = 0.0;
        }
        return projected;
    }

    function calculateDisplayNormals(positions) {
        const normalPositions = requestedTetrahedralProjection || requestedTesseractProjection
            ? projectPositionsForNormals(positions)
            : positions;
        return isComplexEquationData
            ? projectedComplexNormals(normalPositions, positions)
            : projectedBoundaryNormals(normalPositions);
    }

    currentNormals.set(calculateDisplayNormals(currentPositions));
    const originalPositions = new Float32Array(currentPositions);
    const originalNormals = new Float32Array(currentNormals);

    // 同じXYZ位置の点をグループ化し、各点の順番とグループ内の個数をGPUへ渡す。
    const duplicateInfo = new Float32Array(pointCount * 2);
    let colorWMin = 0.0;
    let colorWMax = 1.5;
    function rebuildDuplicateInfo(positions) {
        const groups = new Map();
        const precision = 100000;
        colorWMin = Infinity;
        colorWMax = -Infinity;
        for (let i = 0; i < pointCount; i++) {
            const offset = i * 4;
            const w = positions[offset + 3];
            // 正のWの色相範囲は維持しつつ、重なり順は正負を含む全点で作る。
            if (w > 0.0) {
                colorWMin = Math.min(colorWMin, w);
                colorWMax = Math.max(colorWMax, w);
            }
            let x = positions[offset], y = positions[offset + 1], z = positions[offset + 2];
            const pointW = positions[offset + 3];
            if (requestedTetrahedralProjection) {
                const inverseRootThree = 1.0 / Math.sqrt(3.0);
                [x, y, z] = [
                    (x + y - z - pointW) * inverseRootThree,
                    (x - y + z - pointW) * inverseRootThree,
                    (x - y - z + pointW) * inverseRootThree
                ];
            } else if (requestedTesseractProjection) {
                const perspectiveScale = wPerspectiveDistance / (wPerspectiveDistance + pointW);
                x *= perspectiveScale;
                y *= perspectiveScale;
                z *= perspectiveScale;
            }
            const key = `${Math.round(x * precision)},${Math.round(y * precision)},${Math.round(z * precision)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(i);
        }
        for (const indices of groups.values()) {
            const count = indices.length;
            for (let rank = 0; rank < count; rank++) {
                const offset = indices[rank] * 2;
                duplicateInfo[offset] = rank;
                duplicateInfo[offset + 1] = count;
            }
        }
        if (!Number.isFinite(colorWMin)) {
            colorWMin = 0.0;
            colorWMax = 1.0;
        } else if (colorWMax - colorWMin < 1.0e-6) {
            colorWMax = colorWMin + 1.0e-6;
        }
    }
    rebuildDuplicateInfo(currentPositions);

    // 各軸を線の帯（6頂点）と矢じり（3頂点）で描く画面向けジオメトリ。
    const axisVerticesPerLine = 9;
    const axisVertexCount = axisVerticesPerLine * axisCount;
    const axisLineStarts = new Float32Array(axisVertexCount * 4);
    const axisLineEnds = new Float32Array(axisVertexCount * 4);
    const axisCorners = new Float32Array(axisVertexCount * 3);
    const axisVertexColors = new Float32Array(axisVertexCount * 3);
    // corner = (線に沿った位置, 垂直方向の幅倍率, 進行方向の画面ピクセル補正)
    const axisShape = [
        [0,-0.5,0], [0,0.5,0], [0.88,-0.5,0],
        [0,0.5,0], [0.88,0.5,0], [0.88,-0.5,0],
        [0.88,-2.5,-5], [0.88,2.5,-5], [1,0,0]
    ];

    function rebuildAxisQuadData(positions) {
        for (let axis = 0; axis < axisCount; axis++) {
            const startIndex = pointCount + axis * 2;
            const endIndex = startIndex + 1;
            for (let vertex = 0; vertex < axisVerticesPerLine; vertex++) {
                const outputVertex = axis * axisVerticesPerLine + vertex;
                const startOffset = startIndex * 4;
                const endOffset = endIndex * 4;
                axisLineStarts.set(positions.subarray(startOffset, startOffset + 4), outputVertex * 4);
                axisLineEnds.set(positions.subarray(endOffset, endOffset + 4), outputVertex * 4);
                axisCorners.set(axisShape[vertex], outputVertex * 3);
                axisVertexColors.set(axisColors.subarray(axis * 3, axis * 3 + 3), outputVertex * 3);
            }
        }
    }
    rebuildAxisQuadData(currentPositions);

    // Normal projection uses a cube. Tetrahedral projection uses a regular octahedron.
    const boxVerticesPerEdge = 6;
    const cubeEdgePairs = [
        [0,1], [0,2], [0,4], [1,3], [1,5], [2,3],
        [2,6], [3,7], [4,5], [4,6], [5,7], [6,7]
    ];
    const octahedronEdgePairs = [
        [0,2], [0,3], [0,4], [0,5], [1,2], [1,3],
        [1,4], [1,5], [2,4], [2,5], [3,4], [3,5]
    ];
    const tesseractEdgePairs = [
        ...cubeEdgePairs,
        ...cubeEdgePairs.map(([start, end]) => [start + 8, end + 8]),
        ...Array.from({length: 8}, (_, corner) => [corner, corner + 8])
    ];
    // Every projection mode frames the same 4D sampling box.
    const squareEdgePairs = [[0,1], [1,3], [3,2], [2,0]];
    const boxEdgePairs = isFlatLogArgView ? squareEdgePairs : tesseractEdgePairs;
    const boxVertexCount = boxEdgePairs.length * boxVerticesPerEdge;
    const boxLineStarts = new Float32Array(boxVertexCount * 4);
    const boxLineEnds = new Float32Array(boxVertexCount * 4);
    const boxCorners = new Float32Array(boxVertexCount * 3);
    const boxColors = new Float32Array(boxVertexCount * 3);
    const boxShape = [
        [0,-0.5,0], [0,0.5,0], [1,-0.5,0],
        [0,0.5,0], [1,0.5,0], [1,-0.5,0]
    ];
    const boxColor = [0.48, 0.50, 0.53];

    function createInitialFramePositions() {
        if (isFlatLogArgView) {
            const r = frameHalfExtent;
            return new Float32Array([
                -r,-r,0,0, r,-r,0,0, -r,r,0,0, r,r,0,0,
                0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
                0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0,
                0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0
            ]);
        }
        const cubeCorners = Array.from({length: 8}, (_, corner) => [
            renderSceneCenter[0] + ((corner & 1) ? frameHalfExtent : -frameHalfExtent),
            renderSceneCenter[1] + ((corner & 2) ? frameHalfExtent : -frameHalfExtent),
            renderSceneCenter[2] + ((corner & 4) ? frameHalfExtent : -frameHalfExtent)
        ]);
        const frameCorners = cubeCorners.map(point => [...point, -frameHalfExtent])
            .concat(cubeCorners.map(point => [...point, frameHalfExtent]));
        return new Float32Array(frameCorners.flat());
    }

    const originalFramePositions = createInitialFramePositions();
    let currentFramePositions = new Float32Array(originalFramePositions);
    let previewFramePositions = new Float32Array(originalFramePositions);

    function rebuildBoxData(framePositions) {
        for (let edge = 0; edge < boxEdgePairs.length; edge++) {
            const [startCorner, endCorner] = boxEdgePairs[edge];
            for (let vertex = 0; vertex < boxVerticesPerEdge; vertex++) {
                const outputVertex = edge * boxVerticesPerEdge + vertex;
                boxLineStarts.set(framePositions.subarray(startCorner * 4, startCorner * 4 + 4), outputVertex * 4);
                boxLineEnds.set(framePositions.subarray(endCorner * 4, endCorner * 4 + 4), outputVertex * 4);
                boxCorners.set(boxShape[vertex], outputVertex * 3);
                boxColors.set(boxColor, outputVertex * 3);
            }
        }
    }
    rebuildBoxData(currentFramePositions);

    // The critical line is a separate 4D curve, tessellated into screen-width strips.
    const criticalLineVerticesPerSegment = 6;
    const criticalLineVertexCount = Math.max(0, criticalLinePointCount - 1) * criticalLineVerticesPerSegment;
    const criticalLineStarts = new Float32Array(criticalLineVertexCount * 4);
    const criticalLineEnds = new Float32Array(criticalLineVertexCount * 4);
    const criticalLineCorners = new Float32Array(criticalLineVertexCount * 3);
    const criticalLineColors = new Float32Array(criticalLineVertexCount * 3);
    const criticalLineShape = [
        [0,-0.5,0], [0,0.5,0], [1,-0.5,0],
        [0,0.5,0], [1,0.5,0], [1,-0.5,0]
    ];
    const criticalLineColor = [1.0, 0.05, 0.85];

    function rebuildCriticalLineData(positions) {
        for (let segment = 0; segment < criticalLinePointCount - 1; segment++) {
            const startOffset = (criticalLineStartIndex + segment) * 4;
            const endOffset = startOffset + 4;
            for (let vertex = 0; vertex < criticalLineVerticesPerSegment; vertex++) {
                const outputVertex = segment * criticalLineVerticesPerSegment + vertex;
                criticalLineStarts.set(positions.subarray(startOffset, startOffset + 4), outputVertex * 4);
                criticalLineEnds.set(positions.subarray(endOffset, endOffset + 4), outputVertex * 4);
                criticalLineCorners.set(criticalLineShape[vertex], outputVertex * 3);
                criticalLineColors.set(criticalLineColor, outputVertex * 3);
            }
        }
    }
    rebuildCriticalLineData(currentPositions);

    // 表示用バッファ
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, currentPositions, gl.DYNAMIC_DRAW);
    const normalBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, currentNormals, gl.DYNAMIC_DRAW);
    const duplicateInfoBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, duplicateInfoBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, duplicateInfo, gl.DYNAMIC_DRAW);
    const complexHueBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, complexHueBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, complexHueValues, gl.STATIC_DRAW);
    const pointVisibilityBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pointVisibilityBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, pointVisibility, gl.STATIC_DRAW);

    const renderPositionLocation = gl.getAttribLocation(renderProgram, "a_position");
    const renderNormalLocation = gl.getAttribLocation(renderProgram, "a_normal");
    const duplicateRankLocation = gl.getAttribLocation(renderProgram, "a_duplicateRank");
    const duplicateCountLocation = gl.getAttribLocation(renderProgram, "a_duplicateCount");
    const complexHueLocation = gl.getAttribLocation(renderProgram, "a_complexHue");
    const pointVisibilityLocation = gl.getAttribLocation(renderProgram, "a_pointVisible");
    const stationaryMarkerModeLocation = gl.getUniformLocation(renderProgram, "u_stationaryMarkerMode");
    const unlitModeLocation = gl.getUniformLocation(renderProgram, "u_unlitMode");
    const renderVao = gl.createVertexArray();
    gl.bindVertexArray(renderVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.enableVertexAttribArray(renderPositionLocation);
    gl.vertexAttribPointer(renderPositionLocation, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
    gl.enableVertexAttribArray(renderNormalLocation);
    gl.vertexAttribPointer(renderNormalLocation, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, duplicateInfoBuffer);
    gl.enableVertexAttribArray(duplicateRankLocation);
    gl.vertexAttribPointer(duplicateRankLocation, 1, gl.FLOAT, false, 2 * Float32Array.BYTES_PER_ELEMENT, 0);
    gl.enableVertexAttribArray(duplicateCountLocation);
    gl.vertexAttribPointer(duplicateCountLocation, 1, gl.FLOAT, false, 2 * Float32Array.BYTES_PER_ELEMENT, Float32Array.BYTES_PER_ELEMENT);
    gl.bindBuffer(gl.ARRAY_BUFFER, complexHueBuffer);
    gl.enableVertexAttribArray(complexHueLocation);
    gl.vertexAttribPointer(complexHueLocation, 1, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, pointVisibilityBuffer);
    gl.enableVertexAttribArray(pointVisibilityLocation);
    gl.vertexAttribPointer(pointVisibilityLocation, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    let stationaryVao = null;
    if (stationaryPointCount > 0) {
        stationaryVao = gl.createVertexArray();
        gl.bindVertexArray(stationaryVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.enableVertexAttribArray(renderPositionLocation);
        gl.vertexAttribPointer(renderPositionLocation, 4, gl.FLOAT, false, 0,
            stationaryStartIndex * 4 * Float32Array.BYTES_PER_ELEMENT);
        gl.bindVertexArray(null);
    }

    const axesProgramLocations = {
        start: gl.getAttribLocation(axesProgram, "a_lineStart"),
        end: gl.getAttribLocation(axesProgram, "a_lineEnd"),
        corner: gl.getAttribLocation(axesProgram, "a_corner"),
        color: gl.getAttribLocation(axesProgram, "a_axisColor")
    };
    const axisLineStartBuffer = gl.createBuffer();
    const axisLineEndBuffer = gl.createBuffer();
    const axisCornerBuffer = gl.createBuffer();
    const axisColorBuffer = gl.createBuffer();
    const axesVao = gl.createVertexArray();
    gl.bindVertexArray(axesVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, axisLineStartBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, axisLineStarts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(axesProgramLocations.start);
    gl.vertexAttribPointer(axesProgramLocations.start, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, axisLineEndBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, axisLineEnds, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(axesProgramLocations.end);
    gl.vertexAttribPointer(axesProgramLocations.end, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, axisCornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, axisCorners, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(axesProgramLocations.corner);
    gl.vertexAttribPointer(axesProgramLocations.corner, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, axisColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, axisVertexColors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(axesProgramLocations.color);
    gl.vertexAttribPointer(axesProgramLocations.color, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const boxStartBuffer = gl.createBuffer();
    const boxEndBuffer = gl.createBuffer();
    const boxCornerBuffer = gl.createBuffer();
    const boxColorBuffer = gl.createBuffer();
    const boundsBoxVao = gl.createVertexArray();
    gl.bindVertexArray(boundsBoxVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, boxStartBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, boxLineStarts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(axesProgramLocations.start);
    gl.vertexAttribPointer(axesProgramLocations.start, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, boxEndBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, boxLineEnds, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(axesProgramLocations.end);
    gl.vertexAttribPointer(axesProgramLocations.end, 4, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, boxCornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, boxCorners, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(axesProgramLocations.corner);
    gl.vertexAttribPointer(axesProgramLocations.corner, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, boxColorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, boxColors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(axesProgramLocations.color);
    gl.vertexAttribPointer(axesProgramLocations.color, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    let criticalLineVao = null;
    let criticalLineStartBuffer = null;
    let criticalLineEndBuffer = null;
    if (criticalLineVertexCount > 0) {
        criticalLineStartBuffer = gl.createBuffer();
        criticalLineEndBuffer = gl.createBuffer();
        const criticalLineCornerBuffer = gl.createBuffer();
        const criticalLineColorBuffer = gl.createBuffer();
        criticalLineVao = gl.createVertexArray();
        gl.bindVertexArray(criticalLineVao);
        gl.bindBuffer(gl.ARRAY_BUFFER, criticalLineStartBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, criticalLineStarts, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(axesProgramLocations.start);
        gl.vertexAttribPointer(axesProgramLocations.start, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, criticalLineEndBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, criticalLineEnds, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(axesProgramLocations.end);
        gl.vertexAttribPointer(axesProgramLocations.end, 4, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, criticalLineCornerBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, criticalLineCorners, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(axesProgramLocations.corner);
        gl.vertexAttribPointer(axesProgramLocations.corner, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, criticalLineColorBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, criticalLineColors, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(axesProgramLocations.color);
        gl.vertexAttribPointer(axesProgramLocations.color, 3, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
    }

    // 回転計算用の入力頂点配列
    const rotationPositionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, rotationPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, currentPositions, gl.DYNAMIC_DRAW);
    const rotationVao = gl.createVertexArray();
    gl.bindVertexArray(rotationVao);
    const rotationPositionLocation = gl.getAttribLocation(rotationProgram, "a_position");
    gl.bindBuffer(gl.ARRAY_BUFFER, rotationPositionBuffer);
    gl.enableVertexAttribArray(rotationPositionLocation);
    gl.vertexAttribPointer(rotationPositionLocation, 4, gl.FLOAT, false, 0, 0);

    // 回転の出力は4要素の位置だけ。法線は回転後の投影点群から別途推定する。
    const transformFeedbackBuffer = gl.createBuffer();
    gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, transformFeedbackBuffer);
    gl.bufferData(gl.TRANSFORM_FEEDBACK_BUFFER, vertexCount * 4 * Float32Array.BYTES_PER_ELEMENT, gl.DYNAMIC_READ);
    const transformFeedback = gl.createTransformFeedback();
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, transformFeedback);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, transformFeedbackBuffer);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);

    const rotationAxisALocation = gl.getUniformLocation(rotationProgram, "u_axisA");
    const rotationAxisBLocation = gl.getUniformLocation(rotationProgram, "u_axisB");
    const rotationAngleLocation = gl.getUniformLocation(rotationProgram, "u_angle");
    const projectionLocation = gl.getUniformLocation(renderProgram, "u_projection");
    const viewLocation = gl.getUniformLocation(renderProgram, "u_view");
    const pointSizeLocation = gl.getUniformLocation(renderProgram, "u_pointSize");
    const displayHalfExtentLocation = gl.getUniformLocation(renderProgram, "u_displayHalfExtent");
    const octahedralClipLocation = gl.getUniformLocation(renderProgram, "u_octahedralClip");
    const duplicateStepLocation = gl.getUniformLocation(renderProgram, "u_duplicateStep");
    const colorWMinLocation = gl.getUniformLocation(renderProgram, "u_wMin");
    const colorWMaxLocation = gl.getUniformLocation(renderProgram, "u_wMax");
    const boundaryOnlyLocation = gl.getUniformLocation(renderProgram, "u_boundaryOnly");
    const complexHueModeLocation = gl.getUniformLocation(renderProgram, "u_complexHueMode");
    const magnitudeColorModeLocation = gl.getUniformLocation(renderProgram, "u_magnitudeColorMode");
    const magnitudePeriodLocation = gl.getUniformLocation(renderProgram, "u_magnitudePeriod");
    const tetrahedralProjectionLocation = gl.getUniformLocation(renderProgram, "u_tetrahedralProjection");
    const tesseractProjectionLocation = gl.getUniformLocation(renderProgram, "u_tesseractProjection");
    const wPerspectiveDistanceLocation = gl.getUniformLocation(renderProgram, "u_wPerspectiveDistance");
    const backgroundTileSizeLocation = gl.getUniformLocation(backgroundProgram, "u_tileSize");
    const axesViewLocation = gl.getUniformLocation(axesProgram, "u_view");
    const axesProjectionLocation = gl.getUniformLocation(axesProgram, "u_projection");
    const axesResolutionLocation = gl.getUniformLocation(axesProgram, "u_resolution");
    const axesLineWidthLocation = gl.getUniformLocation(axesProgram, "u_lineWidth");
    const axesDrawEndpointLocation = gl.getUniformLocation(axesProgram, "u_drawEndpoint");
    const axesEndpointSizeLocation = gl.getUniformLocation(axesProgram, "u_endpointSize");
    const axesEndpointThresholdLocation = gl.getUniformLocation(axesProgram, "u_endpointThreshold");
    const axesDepthOffsetLocation = gl.getUniformLocation(axesProgram, "u_depthOffset");
    const axesTetrahedralProjectionLocation = gl.getUniformLocation(axesProgram, "u_tetrahedralProjection");
    const axesTesseractProjectionLocation = gl.getUniformLocation(axesProgram, "u_tesseractProjection");
    const axesWPerspectiveDistanceLocation = gl.getUniformLocation(axesProgram, "u_wPerspectiveDistance");

    const previewPositions = new Float32Array(vertexCount * 4);
    const previewNormals = new Float32Array(vertexCount * 4);
    const transformed = new Float32Array(vertexCount * 4);
    const committedAngles = {XY:0, YZ:0, XZ:0, XW:0, YW:0, ZW:0};
    let activeSlider = null;
    let sliderPreviewFrameHandle = 0;
    let pendingSliderPreview = null;
    const continuousRotations = new Map();
    let continuousFrameHandle = 0;
    let continuousLastUpdate = 0;

    function updateRenderBuffers(
        positions,
        normals,
        framePositions = currentFramePositions,
        {updateNormals = true, updateDuplicates = true} = {}
    ) {
        rebuildBoxData(framePositions);
        gl.bindBuffer(gl.ARRAY_BUFFER, boxStartBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, boxLineStarts);
        gl.bindBuffer(gl.ARRAY_BUFFER, boxEndBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, boxLineEnds);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
        if (updateNormals) {
            gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, normals);
        }
        if (updateDuplicates) {
            rebuildDuplicateInfo(positions);
            gl.bindBuffer(gl.ARRAY_BUFFER, duplicateInfoBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, duplicateInfo);
        }
        rebuildAxisQuadData(positions);
        gl.bindBuffer(gl.ARRAY_BUFFER, axisLineStartBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, axisLineStarts);
        gl.bindBuffer(gl.ARRAY_BUFFER, axisLineEndBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, axisLineEnds);
        if (criticalLineVertexCount > 0) {
            rebuildCriticalLineData(positions);
            gl.bindBuffer(gl.ARRAY_BUFFER, criticalLineStartBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, criticalLineStarts);
            gl.bindBuffer(gl.ARRAY_BUFFER, criticalLineEndBuffer);
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, criticalLineEnds);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    function updateRotationInputBuffers(positions) {
        gl.bindBuffer(gl.ARRAY_BUFFER, rotationPositionBuffer);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }

    function scheduleSliderPreview(plane, angle) {
        pendingSliderPreview = {plane, angle};
        if (sliderPreviewFrameHandle !== 0) return;
        sliderPreviewFrameHandle = requestAnimationFrame(() => {
            sliderPreviewFrameHandle = 0;
            const pending = pendingSliderPreview;
            pendingSliderPreview = null;
            if (pending && activeSlider === pending.plane) {
                previewRotation(pending.plane, pending.angle, null, true);
            }
        });
    }

    function cancelScheduledSliderPreview() {
        if (sliderPreviewFrameHandle !== 0) {
            cancelAnimationFrame(sliderPreviewFrameHandle);
            sliderPreviewFrameHandle = 0;
        }
        pendingSliderPreview = null;
    }

    function previewRotation(plane, targetAngle, deltaOverride = null, deferLighting = false) {
        const delta = deltaOverride === null ? targetAngle - committedAngles[plane] : deltaOverride;
        if (Math.abs(delta) < 1.0e-8) {
            previewPositions.set(currentPositions);
            previewNormals.set(currentNormals);
            previewFramePositions.set(currentFramePositions);
            return;
        }

        // 各プレビューは未確定の点ではなく、保存済みの点を基準に計算する。
        const axisA = "XYZW".indexOf(plane[0]);
        const axisB = "XYZW".indexOf(plane[1]);
        function positiveAxisDirection(axisIndex) {
            const startOffset = (pointCount + axisIndex * 2) * 4;
            const endOffset = startOffset + 4;
            const direction = [0, 0, 0, 0];
            let lengthSquared = 0.0;
            for (let component = 0; component < 4; component++) {
                direction[component] = currentPositions[endOffset + component] - currentPositions[startOffset + component];
                lengthSquared += direction[component] * direction[component];
            }
            const inverseLength = 1.0 / Math.sqrt(lengthSquared);
            return direction.map(value => value * inverseLength);
        }
        const basisA = positiveAxisDirection(axisA);
        const rawBasisB = positiveAxisDirection(axisB);
        const projectionBOnA = rawBasisB.reduce((sum, value, i) => sum + value * basisA[i], 0.0);
        const basisBOrthogonal = rawBasisB.map((value, i) => value - projectionBOnA * basisA[i]);
        const basisBLength = Math.hypot(...basisBOrthogonal);
        const basisB = basisBOrthogonal.map(value => value / basisBLength);

        // 枠の頂点にも、点群と同じ4D回転を適用する。
        // 回転平面の2方向への成分だけを回し、それ以外の成分は保つ。
        const cosine = Math.cos(delta);
        const sine = Math.sin(delta);
        for (let offset = 0; offset < currentFramePositions.length; offset += 4) {
            let alpha = 0.0;
            let beta = 0.0;
            for (let component = 0; component < 4; component++) {
                alpha += currentFramePositions[offset + component] * basisA[component];
                beta += currentFramePositions[offset + component] * basisB[component];
            }
            const rotatedAlpha = alpha * cosine - beta * sine;
            const rotatedBeta = alpha * sine + beta * cosine;
            for (let component = 0; component < 4; component++) {
                const value = currentFramePositions[offset + component];
                previewFramePositions[offset + component] = value
                    + (rotatedAlpha - alpha) * basisA[component]
                    + (rotatedBeta - beta) * basisB[component];
            }
        }

        gl.useProgram(rotationProgram);
        gl.uniform4fv(rotationAxisALocation, basisA);
        gl.uniform4fv(rotationAxisBLocation, basisB);
        gl.uniform1f(rotationAngleLocation, delta);
        gl.bindVertexArray(rotationVao);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, transformFeedback);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, transformFeedbackBuffer);
        gl.enable(gl.RASTERIZER_DISCARD);
        gl.beginTransformFeedback(gl.POINTS);
        gl.drawArrays(gl.POINTS, 0, vertexCount);
        gl.endTransformFeedback();
        gl.disable(gl.RASTERIZER_DISCARD);
        gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, transformFeedbackBuffer);
        gl.getBufferSubData(gl.TRANSFORM_FEEDBACK_BUFFER, 0, transformed);
        previewPositions.set(transformed);
        // Recompute after the 4D rotation and XYZ projection. This is essential
        // for XW/YW/ZW rotations, which move W components into visible XYZ.
        if (deferLighting) {
            // Keep the last committed lighting during movement; estimate exact
            // projected normals once when dragging or continuous rotation ends.
            previewNormals.set(currentNormals);
        } else {
            previewNormals.set(calculateDisplayNormals(previewPositions));
        }
        gl.bindBuffer(gl.TRANSFORM_FEEDBACK_BUFFER, null);
        gl.bindVertexArray(null);
        updateRenderBuffers(previewPositions, previewNormals, previewFramePositions, {
            updateNormals: !deferLighting,
            updateDuplicates: !deferLighting,
        });
    }

    function commitPreview(plane) {
        currentPositions.set(previewPositions);
        currentNormals.set(previewNormals);
        currentFramePositions.set(previewFramePositions);
        committedAngles[plane] = rotationAngles[plane];
        updateRotationInputBuffers(currentPositions);
    }

    function stopContinuousRotation(plane = null, refreshAfterStop = true) {
        const wasRunning = continuousRotations.size > 0;
        if (plane === null) {
            for (const button of continuousRotations.values()) button.textContent = "連続回転";
            continuousRotations.clear();
        } else {
            const button = continuousRotations.get(plane);
            if (button) button.textContent = "連続回転";
            continuousRotations.delete(plane);
        }
        if (continuousRotations.size === 0 && continuousFrameHandle !== 0) {
            cancelAnimationFrame(continuousFrameHandle);
            continuousFrameHandle = 0;
        }
        if (wasRunning && continuousRotations.size === 0 && refreshAfterStop) {
            currentNormals.set(calculateDisplayNormals(currentPositions));
            previewNormals.set(currentNormals);
            updateRenderBuffers(currentPositions, currentNormals, currentFramePositions);
        }
        updateContinuousButtonAvailability();
    }

    function animateContinuousRotation(timestamp) {
        if (continuousRotations.size === 0) {
            continuousFrameHandle = 0;
            return;
        }
        continuousFrameHandle = requestAnimationFrame(animateContinuousRotation);
        // Limit expensive point and normal updates to about 30 frames per second.
        if (timestamp - continuousLastUpdate < 1000 / 30) return;
        const elapsed = Math.min((timestamp - continuousLastUpdate) / 1000, 0.1);
        continuousLastUpdate = timestamp;
        const delta = 0.9 * elapsed;

        // The two active planes are complementary, so their 4D rotations are independent.
        for (const plane of continuousRotations.keys()) {
            rotationAngles[plane] = (rotationAngles[plane] + delta) % TWO_PI;
            updateSliderVisual(plane);
            previewRotation(plane, rotationAngles[plane], delta, true);
            commitPreview(plane);
        }
        updateRotationAnglesDisplay();
    }

    function toggleContinuousRotation(plane, button) {
        if (continuousRotations.has(plane)) {
            stopContinuousRotation(plane);
            return;
        }
        if (activeSlider !== null) return;
        const activePlanes = [...continuousRotations.keys()];
        if (activePlanes.length > 0 && COMPLEMENTARY_PLANES[activePlanes[0]] !== plane) return;
        if (activePlanes.length >= 2) return;

        continuousRotations.set(plane, button);
        button.textContent = "連続回転中（停止）";
        if (continuousFrameHandle === 0) {
            continuousLastUpdate = performance.now();
            continuousFrameHandle = requestAnimationFrame(animateContinuousRotation);
        }
        updateContinuousButtonAvailability();
    }

    function restoreOriginalPoints() {
        stopContinuousRotation(null, false);
        currentPositions.set(originalPositions);
        currentNormals.set(originalNormals);
        previewPositions.set(originalPositions);
        previewNormals.set(originalNormals);
        currentFramePositions.set(originalFramePositions);
        previewFramePositions.set(originalFramePositions);
        updateRotationInputBuffers(currentPositions);
        updateRenderBuffers(currentPositions, currentNormals, currentFramePositions);
        for (const plane of ROTATION_PLANES) {
            rotationAngles[plane] = 0.0;
            committedAngles[plane] = 0.0;
        }
        updateRotationAnglesDisplay();
        updateAllSliders();
    }

    // ===== DISPLAY SETTINGS: カメラの初期視点 =====
    // 初期の左右・見下ろし角を変える場合は、次の2値を調整してください。
    const initialYaw = isFlatLogArgView ? 0.0 : 0.5;
    const initialPitch = isFlatLogArgView ? Math.PI / 2.0 : 0.35;
    let yaw = initialYaw;
    let pitch = initialPitch;
    let dragging = false;
    let lastX = 0, lastY = 0;
    canvas.addEventListener("pointerdown", event => {
        if (isFlatLogArgView) return;
        dragging = true;
        lastX = event.clientX;
        lastY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener("pointerup", () => dragging = false);
    canvas.addEventListener("pointercancel", () => dragging = false);
    canvas.addEventListener("pointermove", event => {
        if (!dragging || isFlatLogArgView) return;
        yaw -= (event.clientX - lastX) * 0.008;
        pitch = Math.max(-Math.PI / 2.0, Math.min(Math.PI / 2.0,
            pitch + (event.clientY - lastY) * 0.008));
        lastX = event.clientX;
        lastY = event.clientY;
    });
    document.getElementById("resetCamera").addEventListener("click", () => {
        yaw = initialYaw;
        pitch = initialPitch;
    });

    const controlsContainer = document.getElementById("rotationControls");
    controlsContainer.classList.add("rotation-controls");
    const sliderStates = {};
    const sliderColors = {
        XY:"#d94141", YZ:"#32965a", XZ:"#326bd1",
        XW:"#9b4db8", YW:"#d28a18", ZW:"#1596a3"
    };

    function makeSvgElement(name, attributes) {
        const element = document.createElementNS("http://www.w3.org/2000/svg", name);
        for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
        return element;
    }

    function updateSliderVisual(plane) {
        const state = sliderStates[plane];
        const angle = rotationAngles[plane];
        const x = 50 + 35 * Math.sin(angle);
        const y = 50 - 35 * Math.cos(angle);
        state.hand.setAttribute("x2", x.toFixed(2));
        state.hand.setAttribute("y2", y.toFixed(2));
        state.knob.setAttribute("cx", x.toFixed(2));
        state.knob.setAttribute("cy", y.toFixed(2));
        state.value.textContent = `${angle.toFixed(3)} rad`;
        state.svg.setAttribute("aria-valuenow", angle.toFixed(3));
    }

    function updateContinuousButtonAvailability() {
        const activePlanes = [...continuousRotations.keys()];
        for (const plane of ROTATION_PLANES) {
            const state = sliderStates[plane];
            if (!state) continue;
            const isActive = continuousRotations.has(plane);
            const mayStart = activePlanes.length === 0
                || (activePlanes.length === 1 && COMPLEMENTARY_PLANES[activePlanes[0]] === plane);
            state.continuousButton.disabled = !state.enabled || (!isActive && !mayStart);
            state.continuousButton.textContent = isActive ? "連続回転中（停止）" : "連続回転";
        }
    }

    function updateAllSliders() {
        for (const plane of ROTATION_PLANES) {
            updateSliderVisual(plane);
            const state = sliderStates[plane];
            state.svg.style.cursor = state.enabled ? "grab" : "not-allowed";
            state.dragStatus.textContent = state.enabled
                ? "ドラッグして回転"
            : isFlatLogArgView ? "平面表示では回転不可" : "log・arg表示ではW回転不可";
        }
        updateContinuousButtonAvailability();
    }

    function angleAtPointer(event, svg) {
        const rect = svg.getBoundingClientRect();
        const x = (event.clientX - rect.left) * 100 / rect.width - 50;
        const y = (event.clientY - rect.top) * 100 / rect.height - 50;
        let angle = Math.atan2(x, -y);
        if (angle < 0) angle += TWO_PI;

        // 0、π/4、π/2…の近くでは、その角度に吸着させる。
        const snapInterval = Math.PI / 4.0;
        const snapThreshold = 5.0 * Math.PI / 180.0;
        const nearestSnap = (Math.round(angle / snapInterval) * snapInterval) % TWO_PI;
        const directDistance = Math.abs(angle - nearestSnap);
        const circularDistance = Math.min(directDistance, TWO_PI - directDistance);
        return circularDistance <= snapThreshold ? nearestSnap : angle;
    }

    for (const plane of ROTATION_PLANES) {
        const color = sliderColors[plane];
        const item = document.createElement("div");
        item.className = "rotation-control";

        const title = document.createElement("div");
        title.className = "rotation-title";
        title.textContent = `${plane}回転`;
        item.appendChild(title);

        const rotationPlaneEnabled = !isFlatLogArgView && (!useComplexLogPolarView || !plane.includes("W"));
        const svg = makeSvgElement("svg", {viewBox:"0 0 100 100", width:"96", height:"96", role:"slider"});
        svg.classList.add("rotation-slider");
        svg.setAttribute("aria-label", `${plane}平面の回転角度`);
        svg.setAttribute("aria-disabled", rotationPlaneEnabled ? "false" : "true");
        if (!rotationPlaneEnabled) {
            item.classList.add("rotation-control-disabled");
            item.title = isFlatLogArgView
                ? "色付き平面表示では形を平面に保つため4D回転は無効です。"
                : "log・arg表示ではW軸を使わないため、この回転は無効です。";
        }
        svg.setAttribute("aria-valuemin", "0");
        svg.setAttribute("aria-valuemax", TWO_PI.toString());
        svg.style.cursor = "grab";
        svg.appendChild(makeSvgElement("circle", {
            cx:"50", cy:"50", r:"35", fill:"none", stroke:"#c8c8c8", "stroke-width":"8"
        }));
        // スナップ位置（45度ごと）を示す小さな目印。
        for (let snapIndex = 0; snapIndex < 8; snapIndex++) {
            const snapAngle = snapIndex * Math.PI / 4.0;
            const markerX = 50 + 35 * Math.sin(snapAngle);
            const markerY = 50 - 35 * Math.cos(snapAngle);
            svg.appendChild(makeSvgElement("circle", {
                cx:markerX.toFixed(2), cy:markerY.toFixed(2), r:"2.8",
                fill:"white", stroke:"#555", "stroke-width":"1.2",
                "pointer-events":"none"
            }));
        }
        const hand = makeSvgElement("line", {
            x1:"50", y1:"50", x2:"50", y2:"15", stroke:color,
            "stroke-width":"4", "stroke-linecap":"round", "pointer-events":"none"
        });
        const knob = makeSvgElement("circle", {
            cx:"50", cy:"15", r:"7", fill:color, stroke:"white", "stroke-width":"2",
            "pointer-events":"none"
        });
        const center = makeSvgElement("circle", {
            cx:"50", cy:"50", r:"3", fill:"#555", "pointer-events":"none"
        });
        svg.append(hand, knob, center);
        item.appendChild(svg);

        const value = document.createElement("div");
        value.className = "rotation-value";
        item.appendChild(value);
        const dragStatus = document.createElement("small");
        dragStatus.className = "rotation-drag-status";
        dragStatus.textContent = "ドラッグして回転";
        item.appendChild(dragStatus);
        const continuousButton = document.createElement("button");
        continuousButton.type = "button";
        continuousButton.className = "continuous-rotation-button";
        continuousButton.textContent = "連続回転";
        continuousButton.disabled = !rotationPlaneEnabled;
        continuousButton.setAttribute("aria-label", `${plane}平面の連続回転を開始または停止`);
        continuousButton.addEventListener("click", () => toggleContinuousRotation(plane, continuousButton));
        item.appendChild(continuousButton);
        controlsContainer.appendChild(item);
        sliderStates[plane] = {svg, hand, knob, value, dragStatus, continuousButton, enabled: rotationPlaneEnabled};
        updateContinuousButtonAvailability();

        svg.addEventListener("pointerdown", event => {
            if (!rotationPlaneEnabled || activeSlider !== null || continuousRotations.size > 0 || (event.button !== undefined && event.button !== 0)) return;
            event.preventDefault();
            activeSlider = plane;
            svg.setPointerCapture(event.pointerId);
            svg.style.cursor = "grabbing";
            dragStatus.textContent = "ドラッグ中";
            rotationAngles[plane] = angleAtPointer(event, svg);
            updateRotationAnglesDisplay();
            updateSliderVisual(plane);
            previewRotation(plane, rotationAngles[plane], null, true);
        });

        svg.addEventListener("pointermove", event => {
            if (activeSlider !== plane) return;
            rotationAngles[plane] = angleAtPointer(event, svg);
            updateRotationAnglesDisplay();
            updateSliderVisual(plane);
            scheduleSliderPreview(plane, rotationAngles[plane]);
        });

        svg.addEventListener("pointerup", event => {
            if (activeSlider !== plane) return;
            cancelScheduledSliderPreview();
            rotationAngles[plane] = angleAtPointer(event, svg);
            updateRotationAnglesDisplay();
            updateSliderVisual(plane);
            previewRotation(plane, rotationAngles[plane]);
            commitPreview(plane);
            activeSlider = null;
            svg.style.cursor = "grab";
            dragStatus.textContent = "保存済み";
        });

        svg.addEventListener("pointercancel", () => {
            if (activeSlider !== plane) return;
            cancelScheduledSliderPreview();
            rotationAngles[plane] = committedAngles[plane];
            previewPositions.set(currentPositions);
            previewNormals.set(currentNormals);
            previewFramePositions.set(currentFramePositions);
            updateRenderBuffers(currentPositions, currentNormals, currentFramePositions);
            updateRotationAnglesDisplay();
            updateSliderVisual(plane);
            activeSlider = null;
            svg.style.cursor = "grab";
            dragStatus.textContent = "操作を取り消しました";
        });
    }
    updateAllSliders();
    updateRotationAnglesDisplay();
    document.getElementById("resetRotation").addEventListener("click", restoreOriginalPoints);

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(1.0, 1.0, 1.0, 1.0);
    const displayModeLabel = useComplexLogPolarView
        ? isFlatLogArgView
            ? useLogArgSwap ? "平面=(Re(y), Im(y), 0)、色相=arg(x)" : "平面=(Re(x), Im(x), 0)、色相=arg(y)"
            : useLogArgSwap ? "座標=(Re(y), Im(y), log|x|)、色相=arg(x)"
                : isZetaData ? "座標=(σ, t, log|ζ(s)|)、色相=arg(ζ(s))"
                    : "座標=(Re(x), Im(x), log|y|)、色相=arg(y)"
        : isComplexEquationData ? "複素曲面の接平面法線" : "投影点群の外側境界法線";
    let skippedSingularityPoints = 0;
    for (let i = 0; i < pointCount; i++) skippedSingularityPoints += data.validity[i] === 0 ? 1 : 0;
    const singularityLabel = skippedSingularityPoints > 0
        ? ` · 特異点周辺の${skippedSingularityPoints}点を除外`
        : "";
    const stationaryLabel = stationaryPointCount > 0
        ? ` · 停留点${stationaryPointCount}か所を黒点表示`
        : "";
    const outputScaleLabel = useComplexOutputCompression
        ? " · 複素出力は極端値を滑らかに圧縮表示"
        : "";
    const projectionLabel = requestedTetrahedralProjection
        ? " · 四面体投影・正八面体枠・4D長さ色相"
        : requestedTesseractProjection ? " · 正八胞体型・w中心投影" : "";
    status.textContent = `${pointCount.toLocaleString()}点を表示中${singularityLabel}${stationaryLabel}${outputScaleLabel}${projectionLabel} · ${displayModeLabel} · ${data.equation}`;

    function render() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const aspect = width / height;
        const halfVerticalFov = FIELD_OF_VIEW / 2.0;
        const halfHorizontalFov = Math.atan(Math.tan(halfVerticalFov) * aspect);
        const limitingHalfFov = Math.min(halfVerticalFov, halfHorizontalFov);
        const cameraDistance = sceneRadius / Math.sin(limitingHalfFov) * 1.12;
        const nearPlane = Math.max(cameraDistance - sceneRadius * 1.25, cameraDistance * 1.0e-4, 1.0e-7);
        const farPlane = Math.max(nearPlane * 2.0, cameraDistance + sceneRadius * 1.25);
        const viewMatrix = makeView(yaw, pitch, renderSceneCenter, cameraDistance);
        const projectionMatrix = makePerspective(FIELD_OF_VIEW, aspect, nearPlane, farPlane);

        // 市松模様の背景を先に描き、その後に3Dオブジェクトを重ねる。
        gl.disable(gl.DEPTH_TEST);
        gl.useProgram(backgroundProgram);
        gl.uniform1f(backgroundTileSizeLocation, 24.0 * dpr);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);

        // Draw the display-range cube first so points and axes correctly occlude its far edges.
        gl.useProgram(axesProgram);
        gl.bindVertexArray(boundsBoxVao);
        gl.uniform1i(axesTetrahedralProjectionLocation, requestedTetrahedralProjection ? 1 : 0);
        gl.uniform1i(axesTesseractProjectionLocation, requestedTesseractProjection ? 1 : 0);
        gl.uniform1f(axesWPerspectiveDistanceLocation, wPerspectiveDistance);
        gl.uniformMatrix4fv(axesViewLocation, false, viewMatrix);
        gl.uniformMatrix4fv(axesProjectionLocation, false, projectionMatrix);
        gl.uniform2f(axesResolutionLocation, width, height);
        gl.uniform1f(axesLineWidthLocation, 1.4 * dpr);
        gl.uniform1f(axesEndpointThresholdLocation, 0.0);
        gl.uniform1f(axesDepthOffsetLocation, 0.0);
        gl.uniform1i(axesDrawEndpointLocation, 0);
        gl.drawArrays(gl.TRIANGLES, 0, boxVertexCount);

        gl.useProgram(renderProgram);
        gl.bindVertexArray(renderVao);
        gl.uniformMatrix4fv(viewLocation, false, viewMatrix);
        gl.uniformMatrix4fv(projectionLocation, false, projectionMatrix);
        gl.uniform1f(pointSizeLocation, pointSizePixels * dpr);
        gl.uniform1i(tetrahedralProjectionLocation, requestedTetrahedralProjection ? 1 : 0);
        gl.uniform1i(tesseractProjectionLocation, requestedTesseractProjection ? 1 : 0);
        gl.uniform1f(wPerspectiveDistanceLocation, wPerspectiveDistance);
        gl.uniform1i(magnitudeColorModeLocation, requestedTetrahedralProjection ? 1 : requestedTesseractProjection ? 2 : 0);
        gl.uniform1f(magnitudePeriodLocation, cubeHalfExtent);
        gl.uniform3fv(displayHalfExtentLocation, displayBoxHalfExtents);
        gl.uniform1i(octahedralClipLocation, requestedTetrahedralProjection ? 1 : 0);
        gl.uniform1f(colorWMinLocation, colorWMin);
        gl.uniform1f(colorWMaxLocation, colorWMax);
        gl.uniform1i(boundaryOnlyLocation, isComplexEquationData ? 0 : 1);
        gl.uniform1i(complexHueModeLocation, useComplexLogPolarView ? 1 : 0);
        gl.uniform1i(unlitModeLocation, isFlatLogArgView ? 1 : 0);
        gl.uniform1i(stationaryMarkerModeLocation, 0);
        // 約0.8秒ごとに重なりグループ内の表示点を次へ進める。
        gl.uniform1f(duplicateStepLocation, Math.floor(performance.now() / 800.0));
        gl.drawArrays(gl.POINTS, 0, pointCount);
        if (stationaryVao !== null) {
            gl.disable(gl.DEPTH_TEST);
            gl.uniform1i(stationaryMarkerModeLocation, 1);
            gl.uniform1f(pointSizeLocation, Math.max(10.0, pointSizePixels * 1.8) * dpr);
            gl.bindVertexArray(stationaryVao);
            gl.drawArrays(gl.POINTS, 0, stationaryPointCount);
            gl.uniform1i(stationaryMarkerModeLocation, 0);
            gl.uniform1f(pointSizeLocation, pointSizePixels * dpr);
            gl.enable(gl.DEPTH_TEST);
        }

        // 軸はGL.LINES/gl.lineWidthに依存せず、画面上で一定幅の三角形として描画する。
        gl.useProgram(axesProgram);
        gl.bindVertexArray(axesVao);
        gl.uniform1i(axesTetrahedralProjectionLocation, requestedTetrahedralProjection ? 1 : 0);
        gl.uniform1i(axesTesseractProjectionLocation, requestedTesseractProjection ? 1 : 0);
        gl.uniform1f(axesWPerspectiveDistanceLocation, wPerspectiveDistance);
        gl.uniformMatrix4fv(axesViewLocation, false, viewMatrix);
        gl.uniformMatrix4fv(axesProjectionLocation, false, projectionMatrix);
        gl.uniform2f(axesResolutionLocation, width, height);
        gl.uniform1f(axesLineWidthLocation, 3.0 * dpr);
        gl.uniform1f(axesEndpointSizeLocation, 12.0 * dpr);
        gl.uniform1f(axesEndpointThresholdLocation, 20.0 * dpr);
        gl.uniform1f(axesDepthOffsetLocation, 0.0);
        gl.uniform1i(axesDrawEndpointLocation, 0);
        const visibleAxisVertexCount = isFlatLogArgView ? axisVerticesPerLine * 2 : axisVertexCount;
        gl.drawArrays(gl.TRIANGLES, 0, visibleAxisVertexCount);
        // 軸をほぼ真正面から見た場合は、帯や矢じりを隠して正方向端点を丸く表示する。
        gl.uniform1i(axesDrawEndpointLocation, 1);
        for (let endpointVertex = 8; endpointVertex < visibleAxisVertexCount; endpointVertex += axisVerticesPerLine) {
            gl.drawArrays(gl.POINTS, endpointVertex, 1);
        }
        gl.uniform1i(axesDrawEndpointLocation, 0);
        if (isZetaData && criticalLineVao !== null) {
            // 臨界線はゼータ関数モードでのみ、点群や軸より手前に重ねて描画する。
            gl.disable(gl.DEPTH_TEST);
            gl.bindVertexArray(criticalLineVao);
            gl.uniform1i(axesTetrahedralProjectionLocation, requestedTetrahedralProjection ? 1 : 0);
            gl.uniform1i(axesTesseractProjectionLocation, requestedTesseractProjection ? 1 : 0);
            gl.uniform1f(axesWPerspectiveDistanceLocation, wPerspectiveDistance);
            gl.uniform1f(axesLineWidthLocation, 4.0 * dpr);
            gl.uniform1f(axesEndpointThresholdLocation, 0.0);
            gl.uniform1f(axesDepthOffsetLocation, 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, criticalLineVertexCount);
            gl.enable(gl.DEPTH_TEST);
        }
        requestAnimationFrame(render);
    }
    render();
}

main().catch(error => {
    console.error(error);
    status.textContent = error.message;
});
