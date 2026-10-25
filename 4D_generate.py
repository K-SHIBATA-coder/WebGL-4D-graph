"""Generate the ordinary four-variable or complex-equation point cloud.

The return type of function(p) selects the generator:
  * real expression   -> F(x, y, z, w) = 0 in four variables
  * complex expression -> f(x + yi) = z + wi (complex graph)

Before sampling, SymPy searches for singularities in the symbolic expression.
Grid points near detected poles are skipped. Install SymPy with:
    python -m pip install sympy
"""
import cmath
import itertools
import math
import sys
import threading
import time
from pathlib import Path
from pointcloud_io import write_binary_bundle

try:
    import sympy as sp
    from sympy.calculus.util import singularities as sympy_singularities
except ImportError as error:
    raise SystemExit(
        "この生成器にはSymPyが必要です。先に `python -m pip install sympy` を実行してください。"
    ) from error

OUTPUT = Path(__file__).with_name("data.json")

# ===== USER SETTINGS: 4変数・複素方程式の範囲と分割数 =====
# 表示範囲・点の密度を変えたい場合は、この区画を編集してください。
IMPLICIT_MIN = -5.0
IMPLICIT_MAX = 5.0
IMPLICIT_GRID_STEPS = 48

COMPLEX_PARAM_MIN = -5.0
COMPLEX_PARAM_MAX = 5.0
COMPLEX_GRID_STEPS = 512

IMPLICIT_EQUATION_TEXT = "x^2 + y^2 + z^2 + w^2 - 25 = 0"
COMPLEX_EQUATION_TEXT = "(x + yi)^2 - (z + wi) = 0"

SYMBOLS = sp.symbols("x y z w", real=True)


class ActivityStatus:
    """Show elapsed time during symbolic work whose total duration is unknown."""
    def __init__(self, label):
        self.label = label
        self.started_at = 0.0
        self.stop_event = threading.Event()
        self.thread = None

    def _write(self, message):
        if sys.stdout.isatty():
            sys.stdout.write("\r" + message.ljust(80))
            sys.stdout.flush()
        else:
            print(message, flush=True)

    def _heartbeat(self):
        while not self.stop_event.wait(1.0):
            elapsed = time.monotonic() - self.started_at
            self._write(f"{self.label} - 経過 {elapsed:.0f} 秒")

    def __enter__(self):
        self.started_at = time.monotonic()
        self._write(f"{self.label} - 開始")
        self.thread = threading.Thread(target=self._heartbeat, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, error_type, error, traceback):
        self.stop_event.set()
        self.thread.join()
        elapsed = time.monotonic() - self.started_at
        message = f"{self.label} - 完了 ({elapsed:.1f} 秒)"
        if sys.stdout.isatty():
            sys.stdout.write("\r" + message.ljust(80) + "\n")
            sys.stdout.flush()
        else:
            print(message, flush=True)
        return False


class ProgressBar:
    """Display a throttled, dependency-free terminal progress bar."""
    def __init__(self, label, total, width=28):
        self.label = label
        self.total = max(1, int(total))
        self.width = width
        self.current = 0
        self.started_at = time.monotonic()
        self.last_update = 0.0
        self.update(force=True)

    def update(self, amount=0, force=False):
        self.current = min(self.total, self.current + amount)
        now = time.monotonic()
        if not force and self.current < self.total and now - self.last_update < 0.15:
            return
        self.last_update = now
        fraction = self.current / self.total
        filled = int(self.width * fraction)
        elapsed = now - self.started_at
        rate = self.current / elapsed if elapsed > 0.0 else 0.0
        remaining = (self.total - self.current) / rate if rate > 0.0 else 0.0
        bar = "=" * filled + " " * (self.width - filled)
        message = (
            f"{self.label} [{bar}] {fraction * 100:5.1f}% "
            f"{self.current:,}/{self.total:,}  経過 {elapsed:,.1f}s  残り {remaining:,.1f}s"
        )
        if sys.stdout.isatty():
            sys.stdout.write("\r" + message)
            if self.current >= self.total:
                sys.stdout.write("\n")
        else:
            print(message, flush=True)
        sys.stdout.flush()


# ===== USER EDIT HERE: 描画する方程式 =====
# p=(x,y,z,w)を受け取り、実数式なら4変数方程式、複素数式なら複素グラフ/複素方程式として生成します。
# 使う式のreturnだけを有効にし、ほかの式はコメントアウトしてください。
def function(p):
    """The equation to graph; p is (x, y, z, w).

    Keep one return active. For a complex graph, use a complex equation of the
    form f(x+yi) - (z+wi) = 0. For a four-variable equation, return a real F.
    Use SymPy functions (for example sp.sin) when adding transcendental terms.
    """
    x, y, z, w = p

    # Original complex-equation mode.
    return (x + y * 1j) ** 2 - (z + w * 1j)

    # Example four-variable mode (sphere): comment out the complex return above
    # and uncomment this real-valued expression.
    # return x*x + y*y + z*z + w*w - 25


def make_symbolic_expression(equation_function, mode):
    """Evaluate the user's function on real SymPy symbols before numeric sampling."""
    x, y, z, w = SYMBOLS
    symbolic_input = (x, y, 0, 0) if mode == "complex" else SYMBOLS
    try:
        return sp.sympify(equation_function(symbolic_input))
    except Exception as error:
        raise TypeError(
            "function(p)をSymPy式にできませんでした。math関数ではなくsp.sinなどSymPy関数を使ってください。"
        ) from error


def make_grid_axes(mode, active_symbols=None):
    """Build grids only for variables used by the equation; unused ones stay zero."""
    if mode == "complex":
        steps = COMPLEX_GRID_STEPS
        minimum, maximum = COMPLEX_PARAM_MIN, COMPLEX_PARAM_MAX
        values = [minimum + i * (maximum - minimum) / steps for i in range(steps + 1)]
        return [values, values], SYMBOLS[:2]

    steps = COMPLEX_GRID_STEPS if mode == "complex-implicit" else IMPLICIT_GRID_STEPS
    minimum, maximum = IMPLICIT_MIN, IMPLICIT_MAX
    values = [minimum + i * (maximum - minimum) / steps for i in range(steps + 1)]
    if active_symbols is None:
        active_symbols = SYMBOLS
    return [values for _ in active_symbols], tuple(active_symbols)


def find_singularities(symbolic_expression, mode, active_symbols=None):
    """Use SymPy singularity analysis and denominator roots to mask pole neighborhoods.

    The multivariable roots are evaluated over the sampling grid in the remaining
    variables. This finds isolated singularities as well as pole planes/curves.
    """
    if active_symbols is None:
        active_symbols = SYMBOLS[:2] if mode == "complex" else tuple(
            symbol for symbol in SYMBOLS if symbol in symbolic_expression.free_symbols
        )
    grid_axes, active_symbols = make_grid_axes(mode, active_symbols)
    dimensions = len(active_symbols)
    steps = COMPLEX_GRID_STEPS if mode in ("complex", "complex-implicit") else IMPLICIT_GRID_STEPS
    margin = 1  # Exclude the nearest grid sample and one sample around it.
    excluded_indices = set()
    singularity_descriptions = {}

    try:
        denominator = sp.denom(sp.together(symbolic_expression))
    except Exception:
        denominator = sp.Integer(1)

    for axis, variable in enumerate(active_symbols):
        roots = []

        # SymPy's dedicated singularities() handles many non-rational functions.
        try:
            singular_set = sympy_singularities(symbolic_expression, variable)
            if isinstance(singular_set, sp.FiniteSet):
                roots.extend(list(singular_set))
            else:
                low, high = grid_axes[axis][0], grid_axes[axis][-1]
                bounded = singular_set.intersect(sp.Interval(min(low, high), max(low, high)))
                if isinstance(bounded, sp.FiniteSet):
                    roots.extend(list(bounded))
        except (NotImplementedError, TypeError, ValueError, AttributeError):
            pass

        # Solving the rational denominator also works for multivariable pole sets.
        if denominator != 1 and variable in denominator.free_symbols:
            try:
                roots.extend(sp.solve(denominator, variable))
            except (NotImplementedError, TypeError, ValueError, sp.SympifyError):
                pass

        unique_roots = []
        seen_roots = set()
        for root in roots:
            try:
                root = sp.simplify(root)
                if variable in root.free_symbols:
                    continue
                key = sp.srepr(root)
                if key not in seen_roots:
                    seen_roots.add(key)
                    unique_roots.append(root)
            except (AttributeError, TypeError, ValueError):
                continue

        other_symbols = tuple(symbol for i, symbol in enumerate(active_symbols) if i != axis)
        for root in unique_roots:
            description_key = (str(variable), str(root))
            singularity_descriptions[description_key] = {
                "variable": str(variable),
                "root": str(root),
            }
            try:
                root_function = sp.lambdify(other_symbols, root, modules="math")
            except (TypeError, ValueError, sp.SympifyError):
                continue

            other_axes = [grid_axes[i] for i in range(dimensions) if i != axis]
            other_index_ranges = [range(len(values)) for values in other_axes]
            for other_indices in itertools.product(*other_index_ranges):
                other_values = [other_axes[i][index] for i, index in enumerate(other_indices)]
                try:
                    root_value = complex(root_function(*other_values))
                except Exception:
                    continue
                if not math.isfinite(root_value.real) or not math.isfinite(root_value.imag):
                    continue
                if abs(root_value.imag) > 1.0e-8 * max(1.0, abs(root_value.real)):
                    continue

                axis_values = grid_axes[axis]
                low, high = axis_values[0], axis_values[-1]
                if root_value.real < min(low, high) - abs(axis_values[1] - axis_values[0]):
                    continue
                if root_value.real > max(low, high) + abs(axis_values[1] - axis_values[0]):
                    continue
                step_size = axis_values[1] - axis_values[0]
                root_index = int(round((root_value.real - axis_values[0]) / step_size))
                root_index = max(0, min(len(axis_values) - 1, root_index))
                anchor = [0] * dimensions
                anchor[axis] = root_index
                other_axis_numbers = [i for i in range(dimensions) if i != axis]
                for i, other_axis_number in enumerate(other_axis_numbers):
                    anchor[other_axis_number] = other_indices[i]

                # A small neighborhood creates a visible gap and protects finite differences.
                for offsets in itertools.product(range(-margin, margin + 1), repeat=dimensions):
                    neighbor = tuple(
                        max(0, min(len(grid_axes[i]) - 1, anchor[i] + offsets[i]))
                        for i in range(dimensions)
                    )
                    excluded_indices.add(neighbor)

    descriptions = [singularity_descriptions[key] for key in sorted(singularity_descriptions)]
    return excluded_indices, descriptions


def normal_at_implicit(p, equation_function):
    """Estimate the four-dimensional gradient using central differences."""
    h = 1e-5
    gradient = []
    try:
        for axis in range(4):
            before = list(p)
            after = list(p)
            before[axis] -= h
            after[axis] += h
            gradient.append(
                (float(equation_function(after)) - float(equation_function(before)))
                / (2.0 * h)
            )
    except (ArithmeticError, OverflowError, TypeError, ValueError):
        return [0.0, 0.0, 0.0, 0.0]

    if not all(math.isfinite(value) for value in gradient):
        return [0.0, 0.0, 0.0, 0.0]
    length = math.sqrt(sum(value * value for value in gradient))
    if length == 0.0:
        return [0.0, 0.0, 0.0, 0.0]
    return [value / length for value in gradient]


def generate_four_variable_points(equation_function, excluded_indices, active_symbols):
    """Find zero crossings in the equation's active dimensions; all others are zero."""
    dimensions = len(active_symbols)
    if dimensions == 0:
        raise ValueError("四変数方程式にはx,y,z,wのいずれかを含めてください。")

    steps = IMPLICIT_GRID_STEPS
    step_size = (IMPLICIT_MAX - IMPLICIT_MIN) / steps
    side = steps + 1
    active_axes = [SYMBOLS.index(symbol) for symbol in active_symbols]

    def coordinates(index):
        position = [0.0, 0.0, 0.0, 0.0]
        for grid_axis, coordinate_axis in enumerate(active_axes):
            position[coordinate_axis] = IMPLICIT_MIN + index[grid_axis] * step_size
        return tuple(position)

    grid_total = side ** dimensions
    grid_progress = ProgressBar("格子値を計算中", grid_total)
    values = {}
    for index in itertools.product(range(side), repeat=dimensions):
        if index in excluded_indices:
            values[index] = None
            grid_progress.update(1)
            continue
        try:
            value = float(equation_function(coordinates(index)))
            values[index] = value if math.isfinite(value) else None
        except (ArithmeticError, OverflowError, TypeError, ValueError):
            values[index] = None
        grid_progress.update(1)

    points_by_key = {}
    crossing_progress = ProgressBar("零点を検索中", grid_total)
    for index in itertools.product(range(side), repeat=dimensions):
        crossing_progress.update(1)
        value_a = values[index]
        if value_a is None:
            continue
        for axis in range(dimensions):
            if index[axis] == steps:
                continue
            neighbor = list(index)
            neighbor[axis] += 1
            neighbor = tuple(neighbor)
            value_b = values[neighbor]
            if value_b is None:
                continue
            if (value_a < 0.0) == (value_b < 0.0) and value_a != 0.0 and value_b != 0.0:
                continue
            if value_a == value_b:
                continue

            t = value_a / (value_a - value_b)
            a = coordinates(index)
            b = coordinates(neighbor)
            position = [a[i] + t * (b[i] - a[i]) for i in range(4)]
            key = tuple(round(component, 7) for component in position)
            if key not in points_by_key:
                points_by_key[key] = {
                    "position": position,
                    "normal": normal_at_implicit(position, equation_function),
                }
    return list(points_by_key.values())


def generate_holomorphic_binomial_points(symbolic_expression, active_symbols, excluded_indices):
    """Fast path for a_n(x,y)*(z+iw)^n + a_0(x,y) = 0."""
    if tuple(active_symbols) != tuple(SYMBOLS):
        return None

    output_variable, conjugate_output = sp.symbols("complex_output complex_output_conjugate")
    replacement = {
        SYMBOLS[2]: (output_variable + conjugate_output) / 2,
        SYMBOLS[3]: (output_variable - conjugate_output) / (2 * sp.I),
    }
    try:
        output_expression = sp.expand(symbolic_expression.subs(replacement, simultaneous=True))
        if conjugate_output in output_expression.free_symbols:
            return None
        polynomial = sp.Poly(output_expression, output_variable)
    except (TypeError, ValueError, sp.PolynomialError):
        return None

    terms = {powers[0]: coefficient for powers, coefficient in polynomial.terms()}
    degree = polynomial.degree()
    if degree < 1 or len(terms) != 2 or 0 not in terms or degree not in terms:
        return None

    leading_coefficient = terms[degree]
    constant_coefficient = terms[0]
    input_symbols = tuple(SYMBOLS[:2])
    if (leading_coefficient.free_symbols | constant_coefficient.free_symbols) - set(input_symbols):
        return None
    try:
        coefficients_at = sp.lambdify(
            input_symbols, [leading_coefficient, constant_coefficient], modules="math"
        )
    except (TypeError, ValueError, sp.SympifyError):
        return None

    steps = COMPLEX_GRID_STEPS
    side = steps + 1
    step_size = (IMPLICIT_MAX - IMPLICIT_MIN) / steps
    progress = ProgressBar("複素多項式の点を計算中", degree * side * side)
    # Store one complete x-y grid per root branch. The WebGL normal estimator
    # indexes points as branch -> x -> y, so interleaving roots per grid sample
    # would make it calculate gradients between unrelated points.
    points_by_branch = [[] for _ in range(degree)]
    for x_index in range(side):
        x_value = IMPLICIT_MIN + x_index * step_size
        for y_index in range(side):
            y_value = IMPLICIT_MIN + y_index * step_size
            try:
                leading, constant = (complex(value) for value in coefficients_at(x_value, y_value))
                valid_coefficients = (
                    math.isfinite(leading.real) and math.isfinite(leading.imag)
                    and math.isfinite(constant.real) and math.isfinite(constant.imag)
                    and abs(leading) > 1.0e-14
                )
            except (ArithmeticError, OverflowError, TypeError, ValueError):
                valid_coefficients = False
                leading, constant = 1.0 + 0.0j, 0.0 + 0.0j

            if valid_coefficients:
                target = -constant / leading
                radius = abs(target) ** (1.0 / degree)
                phase = cmath.phase(target) if abs(target) > 0.0 else 0.0
            else:
                radius, phase = 0.0, 0.0

            for branch in range(degree):
                root = cmath.rect(radius, (phase + 2.0 * math.pi * branch) / degree)
                valid = valid_coefficients and math.isfinite(root.real) and math.isfinite(root.imag)
                valid = valid and IMPLICIT_MIN <= root.real <= IMPLICIT_MAX
                valid = valid and IMPLICIT_MIN <= root.imag <= IMPLICIT_MAX
                if valid:
                    grid_index = (
                        x_index,
                        y_index,
                        max(0, min(steps, int(round((root.real - IMPLICIT_MIN) / step_size)))),
                        max(0, min(steps, int(round((root.imag - IMPLICIT_MIN) / step_size)))),
                    )
                    valid = grid_index not in excluded_indices
                point = {
                    "position": [x_value, y_value, root.real, root.imag],
                    "normal": [0.0, 0.0, 0.0, 0.0],
                }
                if not valid:
                    point["valid"] = False
                points_by_branch[branch].append(point)
                progress.update(1)
    return [point for branch_points in points_by_branch for point in branch_points]


def generate_complex_implicit_points(symbolic_expression, active_symbols, excluded_indices):
    """Sample Re(F)=Im(F)=0 as regular 2D branch grids when possible."""
    real_part = sp.simplify(sp.re(symbolic_expression))
    imaginary_part = sp.simplify(sp.im(symbolic_expression))
    if not active_symbols:
        raise ValueError("複素方程式にx,y,z,wの変数がありません。")

    # Solving Re(F)=Im(F)=0 directly for z and w can be extremely slow for
    # cubic and higher relations. If the equation is a holomorphic binomial in
    # z+iw, solve its complex roots numerically for each x,y grid point instead.
    fast_points = generate_holomorphic_binomial_points(
        symbolic_expression, active_symbols, excluded_indices
    )
    if fast_points is not None:
        return fast_points

    # A complex equation gives two real constraints. Solve two active coordinates
    # and sample the remaining coordinates. Keeping each branch in its own grid
    # lets the renderer estimate surface normals without treating it as a volume.
    dependent_symbols = tuple(active_symbols[-2:])
    free_symbols = tuple(symbol for symbol in active_symbols if symbol not in dependent_symbols)
    try:
        with ActivityStatus("SymPyで複素方程式の解枝を探索中"):
            branches = sp.solve(
                (real_part, imaginary_part), dependent_symbols, dict=True, simplify=True
            )
    except (NotImplementedError, TypeError, ValueError, sp.SympifyError) as error:
        raise ValueError(
            "複素方程式を点群化できませんでした。SymPyで2変数を残りの変数から解ける形にしてください。"
        ) from error

    usable_branches = []
    for branch in branches:
        if not all(symbol in branch for symbol in dependent_symbols):
            continue
        expressions = [sp.simplify(branch[symbol]) for symbol in dependent_symbols]
        if any(expression.free_symbols - set(free_symbols) for expression in expressions):
            continue
        try:
            branch_function = sp.lambdify(free_symbols, expressions, modules="math")
        except (TypeError, ValueError, sp.SympifyError):
            continue

        # SymPy can return algebraic branches that are never real (for example,
        # the ±i branches of (x+iy)^2 + (z+wi)^2 = 0). Keep branches with at
        # least one real sample in the configured domain, including restricted
        # real branches such as square roots that are real only on part of it.
        sample_values = [
            IMPLICIT_MIN,
            IMPLICIT_MIN * 0.5,
            0.0,
            IMPLICIT_MAX * 0.5,
            IMPLICIT_MAX,
        ]
        has_real_sample = False
        for sample in itertools.product(sample_values, repeat=len(free_symbols)):
            try:
                result = branch_function(*sample)
                if len(dependent_symbols) == 1:
                    result = [result]
                result = [complex(value) for value in result]
                if all(
                    math.isfinite(value.real) and math.isfinite(value.imag)
                    and abs(value.imag) <= 1.0e-8 * max(1.0, abs(value.real))
                    for value in result
                ):
                    has_real_sample = True
                    break
            except Exception:
                continue
        if has_real_sample:
            usable_branches.append(branch_function)
    if not usable_branches:
        raise ValueError(
            "複素方程式の解を明示的に求められませんでした。式を因数分解するか、媒介変数表示で生成してください。"
        )

    steps = COMPLEX_GRID_STEPS
    side = steps + 1
    axis_values = [IMPLICIT_MIN + i * (IMPLICIT_MAX - IMPLICIT_MIN) / steps for i in range(side)]
    free_grid_indices = itertools.product(range(side), repeat=len(free_symbols))
    free_grid_indices = list(free_grid_indices)
    points = []
    progress_total = len(usable_branches) * len(free_grid_indices)
    progress = ProgressBar("複素方程式の点を計算中", progress_total)
    for branch_function in usable_branches:
        for free_indices in free_grid_indices:
            free_values = tuple(axis_values[index] for index in free_indices)
            position_by_symbol = {symbol: value for symbol, value in zip(free_symbols, free_values)}
            valid = True
            try:
                dependent_values = branch_function(*free_values)
                if len(dependent_symbols) == 1:
                    dependent_values = [dependent_values]
                dependent_values = [complex(value) for value in dependent_values]
                valid = not any(
                    not math.isfinite(value.real) or not math.isfinite(value.imag)
                    or abs(value.imag) > 1.0e-8 * max(1.0, abs(value.real))
                    for value in dependent_values
                )
                if valid:
                    position_by_symbol.update({
                        symbol: value.real for symbol, value in zip(dependent_symbols, dependent_values)
                    })
                    valid = all(
                        IMPLICIT_MIN <= position_by_symbol[symbol] <= IMPLICIT_MAX
                        for symbol in active_symbols
                    )
            except Exception:
                valid = False

            if valid:
                nearest_grid_index = tuple(
                    max(0, min(steps, int(round(
                        (position_by_symbol[symbol] - IMPLICIT_MIN)
                        / ((IMPLICIT_MAX - IMPLICIT_MIN) / steps)
                    ))))
                    for symbol in active_symbols
                )
                valid = nearest_grid_index not in excluded_indices

            position = [float(position_by_symbol.get(symbol, 0.0)) for symbol in SYMBOLS]
            point = {
                "position": position,
                "normal": [0.0, 0.0, 0.0, 0.0],
            }
            if not valid:
                point["valid"] = False
            points.append(point)
            progress.update(1)
    return points


def generate_complex_equation_points(complex_equation_function, excluded_indices):
    """Sample f(x+yi)=z+wi, leaving a hole around detected singularities."""
    step = (COMPLEX_PARAM_MAX - COMPLEX_PARAM_MIN) / COMPLEX_GRID_STEPS
    points = []
    total = (COMPLEX_GRID_STEPS + 1) ** 2
    progress = ProgressBar("複素関数の点を計算中", total)
    for i in range(COMPLEX_GRID_STEPS + 1):
        x = COMPLEX_PARAM_MIN + i * step
        for j in range(COMPLEX_GRID_STEPS + 1):
            y = COMPLEX_PARAM_MIN + j * step
            valid = (i, j) not in excluded_indices
            value = 0j
            if valid:
                try:
                    value = complex(complex_equation_function((x, y, 0.0, 0.0)))
                    valid = math.isfinite(value.real) and math.isfinite(value.imag)
                except (ArithmeticError, OverflowError, TypeError, ValueError):
                    valid = False
            points.append({
                "position": [x, y, value.real, value.imag] if valid else [x, y, 0.0, 0.0],
                # The renderer computes the projected 3D normal from grid neighbors.
                "normal": [0.0, 0.0, 0.0, 0.0],
                "valid": valid,
            })
            progress.update(1)
    return points


def write_data(data):
    """Write numeric point arrays to a binary file and descriptive fields to JSON."""
    binary_base = OUTPUT.with_suffix(".bin")
    try:
        point_count, _, binary_path = write_binary_bundle(data, OUTPUT, binary_base)
    except OSError as error:
        raise OSError(
            f"{OUTPUT.name}または点群バイナリを書き込めませんでした。保存先の空き容量とファイルの使用状態を確認してください。"
        ) from error
    print(f"{point_count:,}点を {binary_path.name} に保存し、式などの情報を {OUTPUT.name} に保存しました。")
def equation_text_from_expression(expression):
    """Format the active SymPy expression for the equation label written to JSON."""
    return sp.sstr(sp.simplify(expression))


def main():
    global IMPLICIT_EQUATION_TEXT, COMPLEX_EQUATION_TEXT

    # Analyze the full expression first, then distinguish a complex function graph
    # from an implicit complex equation such as F(x,y,z,w)=0.
    full_symbolic_result = make_symbolic_expression(function, "four-variable")
    imaginary_part = sp.simplify(sp.im(full_symbolic_result))
    is_complex_expression = imaginary_part != 0
    x, y, z, w = SYMBOLS
    has_output_variables = z in full_symbolic_result.free_symbols or w in full_symbolic_result.free_symbols
    graph_candidate = sp.simplify(full_symbolic_result + z + sp.I * w)
    is_complex_function_graph = is_complex_expression and (
        not has_output_variables or not ({z, w} & graph_candidate.free_symbols)
    )

    if is_complex_function_graph:
        mode = "complex"
        symbolic_result = make_symbolic_expression(function, "complex")
        active_symbols = SYMBOLS[:2]
        # This mode plots the complex output of the function as z + wi.
        COMPLEX_EQUATION_TEXT = f"f(x + yi) = {equation_text_from_expression(symbolic_result)}"
    elif is_complex_expression:
        mode = "complex-implicit"
        symbolic_result = full_symbolic_result
        active_symbols = tuple(symbol for symbol in SYMBOLS if symbol in symbolic_result.free_symbols)
        real_text = equation_text_from_expression(sp.re(symbolic_result))
        imag_text = equation_text_from_expression(sp.im(symbolic_result))
        COMPLEX_EQUATION_TEXT = f"{real_text} + i({imag_text}) = 0"
    else:
        mode = "four-variable"
        symbolic_result = full_symbolic_result
        active_symbols = tuple(symbol for symbol in SYMBOLS if symbol in symbolic_result.free_symbols)
        IMPLICIT_EQUATION_TEXT = f"{equation_text_from_expression(symbolic_result)} = 0"

    if mode != "complex" and not active_symbols:
        raise ValueError("方程式にはx,y,z,wの変数が少なくとも1つ必要です。")

    # Locate singularities before evaluating any numeric grid point.
    with ActivityStatus("SymPyで特異点を探索中"):
        excluded_indices, singularity_descriptions = find_singularities(
            symbolic_result, mode, active_symbols
        )
    if mode == "complex":
        equation_text = COMPLEX_EQUATION_TEXT
        bounds = [COMPLEX_PARAM_MIN, COMPLEX_PARAM_MAX]
        grid_steps = COMPLEX_GRID_STEPS
        points = generate_complex_equation_points(function, excluded_indices)
        renderer_mode = "complex"
        grid_shape = [grid_steps + 1, grid_steps + 1]
        grid_branch_count = 1
        generator_name = "equation"
    elif mode == "complex-implicit":
        equation_text = COMPLEX_EQUATION_TEXT
        bounds = [IMPLICIT_MIN, IMPLICIT_MAX]
        grid_steps = COMPLEX_GRID_STEPS
        points = generate_complex_implicit_points(
            symbolic_result, active_symbols, excluded_indices
        )
        renderer_mode = "four-variable"
        grid_shape = [COMPLEX_GRID_STEPS + 1, COMPLEX_GRID_STEPS + 1] if len(active_symbols) == 4 else None
        grid_branch_count = len(points) // ((COMPLEX_GRID_STEPS + 1) ** 2) if grid_shape else 1
        generator_name = "complex-implicit"
    else:
        equation_text = IMPLICIT_EQUATION_TEXT
        bounds = [IMPLICIT_MIN, IMPLICIT_MAX]
        grid_steps = IMPLICIT_GRID_STEPS
        points = generate_four_variable_points(function, excluded_indices, active_symbols)
        renderer_mode = "four-variable"
        grid_shape = None
        grid_branch_count = 1
        generator_name = "equation"

    invalid_count = sum(point.get("valid") is False for point in points)
    data = {
        "equation": equation_text,
        "mode": renderer_mode,
        "equationKind": mode,
        "generator": generator_name,
        "bounds": bounds,
        "gridSteps": grid_steps,
        "gridShape": grid_shape,
        "gridBranchCount": grid_branch_count,
        "activeVariables": [str(symbol) for symbol in active_symbols],
        "fixedVariables": [str(symbol) for symbol in SYMBOLS if symbol not in active_symbols],
        "singularities": singularity_descriptions,
        "excludedGridSamples": len(excluded_indices),
        "points": points,
    }
    write_data(data)
    print(
        f"{mode}: {len(points)}点を {OUTPUT.name} に保存しました。"
        f"SymPy特異点候補 {len(singularity_descriptions)}件、除外点 {invalid_count or len(excluded_indices)}点。"
    )

if __name__ == "__main__":
    main()
