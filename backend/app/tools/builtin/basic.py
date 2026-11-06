"""Calculator and current date/time."""

import ast
import math
import operator
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, Field

from app.models import PermissionLevel
from app.tools.base import Tool, ToolContext, ToolError

# --- Calculator ---------------------------------------------------------------------

_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {
    name: getattr(math, name)
    for name in ("sqrt", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "sinh", "cosh", "tanh", "exp",
                 "log", "log10", "log2", "floor", "ceil", "degrees", "radians", "hypot", "gcd", "lcm", "comb", "perm")
}
_FUNCS |= {"abs": abs, "round": round, "min": min, "max": max, "factorial": math.factorial}
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}
MAX_EXPONENT = 10_000
MAX_FACTORIAL = 1_000
MAX_EXPRESSION = 500


def safe_eval(expression: str) -> float | int:
    """Evaluate arithmetic without eval(): only numbers, operators, and whitelisted math functions."""
    if len(expression) > MAX_EXPRESSION:
        raise ToolError("Expression is too long.")
    try:
        tree = ast.parse(expression.replace("^", "**").replace("×", "*").replace("÷", "/"), mode="eval")
    except SyntaxError as exc:
        raise ToolError(f"Not a valid expression: {exc.msg}") from exc

    def ev(node: ast.AST):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
            left, right = ev(node.left), ev(node.right)
            if isinstance(node.op, ast.Pow) and (abs(right) > MAX_EXPONENT or (abs(left) > 1 and abs(right) * math.log10(abs(left) or 1) > 10_000)):
                raise ToolError("Result would be too large.")
            return _BINOPS[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
            return _UNARY[type(node.op)](ev(node.operand))
        if isinstance(node, ast.Name) and node.id in _CONSTS:
            return _CONSTS[node.id]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS and not node.keywords:
            args = [ev(a) for a in node.args]
            if node.func.id == "factorial" and args and args[0] > MAX_FACTORIAL:
                raise ToolError("Factorial argument too large.")
            return _FUNCS[node.func.id](*args)
        raise ToolError(f"Unsupported element in expression: {ast.dump(node)[:60]}")

    try:
        result = ev(tree)
    except ToolError:
        raise
    except ZeroDivisionError as exc:
        raise ToolError("Division by zero.") from exc
    except (ValueError, TypeError, OverflowError) as exc:
        raise ToolError(f"Math error: {exc}") from exc
    if isinstance(result, float) and result.is_integer() and abs(result) < 1e15:
        result = int(result)
    return result


class CalculatorInput(BaseModel):
    expression: str = Field(description="Arithmetic expression, e.g. '(1250 * 0.15) + sqrt(81)'. Supports + - * / // % ** and math functions like sqrt, log, sin, round, factorial, pi, e.")


async def _calculate(ctx: ToolContext, args: CalculatorInput) -> str:
    return f"{args.expression} = {safe_eval(args.expression)}"


calculator = Tool(
    name="calculator",
    description="Evaluate an arithmetic expression exactly. Use this for any calculation beyond trivial mental math (money, percentages, unit conversions, multi-step arithmetic) instead of computing in your head.",
    input_model=CalculatorInput,
    level=PermissionLevel.automatic,
    handler=_calculate,
    summarize=lambda a: a.expression,
)

# --- Date & time ------------------------------------------------------------------------


class DateTimeInput(BaseModel):
    timezone: str | None = Field(default=None, description="IANA time zone such as 'Europe/London'. Omit for the user's local time zone.")


async def _now(ctx: ToolContext, args: DateTimeInput) -> str:
    now_utc = datetime.now(UTC)
    if args.timezone:
        try:
            local = now_utc.astimezone(ZoneInfo(args.timezone))
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ToolError(f"Unknown time zone: {args.timezone}") from exc
        zone = args.timezone
    else:
        local = now_utc.astimezone()
        zone = local.tzname() or "local"
    return (
        f"Local time ({zone}): {local.strftime('%A, %d %B %Y, %H:%M:%S')} (UTC{local.strftime('%z')})\n"
        f"ISO: {local.isoformat(timespec='seconds')}\nUTC: {now_utc.isoformat(timespec='seconds')}"
    )


current_datetime = Tool(
    name="current_datetime",
    description="Get the current date, time and weekday. Use this whenever the answer depends on today's date or the current time (scheduling, deadlines, 'how long until', time zones).",
    input_model=DateTimeInput,
    level=PermissionLevel.automatic,
    handler=_now,
    summarize=lambda a: a.timezone or "local time",
)
