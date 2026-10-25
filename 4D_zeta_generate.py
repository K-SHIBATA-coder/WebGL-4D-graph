"""Generate a dedicated 4D point cloud for the Riemann zeta graph.

Each point is (x, y, z, w) = (sigma, t, Re(zeta(s)), Im(zeta(s))).
The equation description is saved to zeta_points.json and numeric arrays to a linked binary file.
"""
import cmath
import math
from pathlib import Path
from pointcloud_io import write_binary_bundle

OUTPUT = Path(__file__).with_name("zeta_points.json")
BINARY_OUTPUT = OUTPUT.with_suffix(".bin")

# ===== USER SETTINGS: ゼータ関数の範囲と分割数 =====
# 計算範囲や点の密度を変える場合は、以下の値を編集してください。
SIGMA_MIN = -25.0
SIGMA_MAX = 25.0
T_MIN = -25.0
T_MAX = 25.0
# Keep the pole on the grid for validation: it will be detected and masked before evaluation.
GRID_STEPS = 256

# Bernoulli numbers B_2 through B_20 used in the Euler-Maclaurin expansion.
BERNOULLI_EVEN = (
    1 / 6, -1 / 30, 1 / 42, -1 / 30, 5 / 66,
    -691 / 2730, 7 / 6, -3617 / 510, 43867 / 798, -174611 / 330,
)


def complex_gamma_lanczos(z):
    """Evaluate Gamma(z) for Re(z) >= 1 with a Lanczos approximation."""
    coefficients = (
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7,
    )
    shifted = z - 1.0
    series = coefficients[0]
    for index, coefficient in enumerate(coefficients[1:], start=1):
        series += coefficient / (shifted + index)
    t = shifted + 7.5
    return math.sqrt(2.0 * math.pi) * (t ** (shifted + 0.5)) * cmath.exp(-t) * series


def riemann_zeta(s):
    """Evaluate zeta(s) by Euler-Maclaurin, including the critical strip."""
    s = complex(s)
    if abs(s - 1.0) < 1.0e-14:
        raise ValueError("ζ(s) has a pole at s=1; adjust the sampling domain.")

    # Direct Euler-Maclaurin evaluation in the far-left plane subtracts huge,
    # nearly equal terms and loses most significant digits. Reflect it to Re(s)>1.
    if s.real < 0.0:
        reflected_value = riemann_zeta(1.0 - s)
        return (
            (2.0 ** s)
            * (math.pi ** (s - 1.0))
            * cmath.sin(math.pi * s / 2.0)
            * complex_gamma_lanczos(1.0 - s)
            * reflected_value
        )

    # Increase the finite sum length as |Im(s)| grows to control the correction.
    cutoff = max(48, int(2.5 * abs(s.imag)) + 24)
    total = sum(n ** (-s) for n in range(1, cutoff))
    total += cutoff ** (1.0 - s) / (s - 1.0)
    total += 0.5 * cutoff ** (-s)

    for k, bernoulli in enumerate(BERNOULLI_EVEN, start=1):
        rising_factorial = 1.0 + 0.0j
        for multiplier in range(2 * k - 1):
            rising_factorial *= s + multiplier
        total += (
            bernoulli / math.factorial(2 * k)
            * rising_factorial
            * cutoff ** (-s - (2 * k - 1))
        )
    return total


def find_singularities():
    """Locate known singularities before evaluating any grid points.

    The Riemann zeta function has a simple pole at s=1, i.e. (sigma,t)=(1,0).
    """
    return [{"type": "pole", "sigma": 1.0, "t": 0.0}]


def generate_points(singularities):
    """Sample sigma and t directly, skipping a small disk around each pole."""
    sigma_step = (SIGMA_MAX - SIGMA_MIN) / GRID_STEPS
    t_step = (T_MAX - T_MIN) / GRID_STEPS
    exclusion_radius = 2.0 * math.hypot(sigma_step, t_step)
    for singularity in singularities:
        singularity["exclusionRadius"] = exclusion_radius

    points = []
    for i in range(GRID_STEPS + 1):
        sigma = SIGMA_MIN + i * sigma_step
        for j in range(GRID_STEPS + 1):
            t = T_MIN + j * t_step
            near_pole = any(
                math.hypot(sigma - singularity["sigma"], t - singularity["t"])
                <= singularity["exclusionRadius"]
                for singularity in singularities
            )
            if near_pole:
                # Preserve the rectangular grid with finite placeholder coordinates;
                # the renderer hides these entries and excludes them from normals.
                points.append({
                    "position": [sigma, t, 0.0, 0.0],
                    "normal": [0.0, 0.0, 0.0, 0.0],
                    "valid": False,
                })
                continue

            value = riemann_zeta(complex(sigma, t))
            points.append({
                "position": [sigma, t, value.real, value.imag],
                # The WebGL renderer derives projected normals from grid neighbors.
                "normal": [0.0, 0.0, 0.0, 0.0],
                "valid": True,
            })
    return points


def generate_critical_line():
    """Sample the curve on the critical line Re(s)=1/2 in the 4D graph."""
    sigma = 0.5
    t_step = (T_MAX - T_MIN) / GRID_STEPS
    line = []
    for j in range(GRID_STEPS + 1):
        t = T_MIN + j * t_step
        value = riemann_zeta(complex(sigma, t))
        line.append([sigma, t, value.real, value.imag])
    return line


def main():
    # Identify poles first; no function values are calculated until this is complete.
    singularities = find_singularities()
    points = generate_points(singularities)
    data = {
        "equation": (
            "Riemann zeta graph: x=σ, y=t, "
            "z=Re ζ(σ+it), w=Im ζ(σ+it), "
            f"{SIGMA_MIN}≤σ≤{SIGMA_MAX}, {T_MIN}≤t≤{T_MAX}"
        ),
        "mode": "complex",
        "generator": "riemann-zeta",
        "bounds": [SIGMA_MIN, SIGMA_MAX, T_MIN, T_MAX],
        "gridSteps": GRID_STEPS,
        "gridShape": [GRID_STEPS + 1, GRID_STEPS + 1],
        "singularities": singularities,
        "points": points,
        "criticalLine": generate_critical_line(),
    }

    try:
        point_count, critical_count, binary_path = write_binary_bundle(
            data, OUTPUT, BINARY_OUTPUT
        )
    except OSError as error:
        raise OSError(
            f"{OUTPUT.name}または点群バイナリを書き込めませんでした。保存先の空き容量とファイルの使用状態を確認してください。"
        ) from error

    print(
        f"{point_count:,}点と臨界線{critical_count:,}点を {binary_path.name} に保存し、"
        f"式などの情報を {OUTPUT.name} に保存しました。"
        f"（特異点 {len(singularities)}箇所、除外点 {sum(not point.get('valid', True) for point in points)}点）。"
    )

if __name__ == "__main__":
    main()
