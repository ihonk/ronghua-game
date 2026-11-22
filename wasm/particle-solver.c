#include <stddef.h>
#include <stdint.h>

#define EXPORT(name) __attribute__((export_name(#name)))
#define NEIGHBORS 24
#define BONDS 8
#define PAGE_BYTES 65536

// Match the JavaScript constants and Float64 arithmetic. Round only when
// writing Float32 state, as the TypeScript solver does with its typed arrays.
static const double radius = 1.85;
static const double radius_squared = 3.4225000000000003;
static const double kernel_slope = 1.168736303871439;
static const double rest_density = 3.5841624759025508;
static const int shape_x[BONDS] = {1, -1, 0, 0, 1, -1, 1, -1};
static const int shape_y[BONDS] = {0, 0, 1, -1, 1, -1, -1, 1};

static struct {
    int size, width, height, grid_width, grid_height;
    float *x, *y, *velocity_x, *velocity_y, *heat;
    uint32_t *colors;
    int32_t *bonds;
    uint8_t *alive;
    float *lambda, *shift_x, *shift_y, *correction_x, *correction_y;
    int32_t *head, *next, *nearby;
    uint8_t *nearby_count;
} state;

extern unsigned char __heap_base;

EXPORT(initialize)
uint32_t initialize(int size, int width, int height) {
    if (size <= 0 || width <= 0 || height <= 0) return 0;
    const int grid_width = (int)__builtin_ceil(width / radius);
    const int grid_height = (int)__builtin_ceil(height / radius);
    const uint64_t buckets = (uint64_t)grid_width * grid_height;
    const uint32_t start = ((uintptr_t)&__heap_base + 3) & ~3u;
    const uint64_t end = start + 3 + buckets * sizeof(int32_t) +
        (uint64_t)size * (sizeof(float) * 12 + sizeof(uint32_t) +
                          sizeof(int32_t) * (BONDS + NEIGHBORS + 1) + 2);
    if (end > INT32_MAX) return 0;
    const uint32_t pages = (end + PAGE_BYTES - 1) / PAGE_BYTES;
    const uint32_t current_pages = __builtin_wasm_memory_size(0);
    if (pages > current_pages && __builtin_wasm_memory_grow(0, pages - current_pages) == (size_t)-1) return 0;

    state.size = size;
    state.width = width;
    state.height = height;
    state.grid_width = grid_width;
    state.grid_height = grid_height;
    uintptr_t cursor = start;

    // Shared layout from makeParticleViews. The two previous-position arrays
    // are read and written in TypeScript for interpolation.
#define ALLOC(field, length)                            \
    state.field = (void *)cursor;                      \
    cursor += sizeof(*state.field) * (length)
    ALLOC(x, size);
    ALLOC(y, size);
    cursor += sizeof(float) * 2 * size;
    ALLOC(velocity_x, size);
    ALLOC(velocity_y, size);
    ALLOC(heat, size);
    ALLOC(colors, size);
    ALLOC(bonds, BONDS * size);
    ALLOC(alive, size);
    cursor = (cursor + 3) & ~3u;

    ALLOC(lambda, size);
    ALLOC(shift_x, size);
    ALLOC(shift_y, size);
    ALLOC(correction_x, size);
    ALLOC(correction_y, size);
    ALLOC(head, buckets);
    ALLOC(next, size);
    ALLOC(nearby, NEIGHBORS * size);
    ALLOC(nearby_count, size);
#undef ALLOC
    return start;
}

static inline double positive(double value) {
    return value > 0 ? value : 0;
}

static inline double clamp(double value, double lo, double hi) {
    return value < lo ? lo : value > hi ? hi : value;
}

static void contain(int predicted) {
    const double right = state.width - .5;
    const double top = state.height - .5;
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        const double x = state.x[i], y = state.y[i];
        const double cx = clamp(x, .5, right), cy = clamp(y, .5, top);
        state.correction_x[i] = predicted ? cx - x : state.correction_x[i] + (cx - x);
        state.correction_y[i] = predicted ? cy - y : state.correction_y[i] + (cy - y);
        state.x[i] = cx;
        state.y[i] = cy;
    }
}

static void find_neighbors(void) {
    const int width = state.grid_width, height = state.grid_height;
    const double reach = radius + .32;
    for (int i = 0; i < width * height; i++) state.head[i] = -1;
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        // Containment has already made both positions positive.
        const int bucket = (int)(state.x[i] / radius) + (int)(state.y[i] / radius) * width;
        state.next[i] = state.head[bucket];
        state.head[bucket] = i;
    }
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        const double x = state.x[i], y = state.y[i];
        const int min_x = (int)positive((x - reach) / radius);
        const int max_x = (int)clamp((x + reach) / radius, 0, width - 1);
        const int min_y = (int)positive((y - reach) / radius);
        const int max_y = (int)clamp((y + reach) / radius, 0, height - 1);
        int count = 0;
        const int offset = i * NEIGHBORS;
        for (int row = min_y; row <= max_y && count < NEIGHBORS; row++) {
            for (int col = min_x; col <= max_x && count < NEIGHBORS; col++) {
                for (int j = state.head[row * width + col]; j >= 0 && count < NEIGHBORS; j = state.next[j]) {
                    if (i == j) continue;
                    const double dx = x - state.x[j], dy = y - state.y[j];
                    if (dx * dx + dy * dy < reach * reach) state.nearby[offset + count++] = j;
                }
            }
        }
        state.nearby_count[i] = count;
    }
}

static void compute_density(void) {
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        const double x = state.x[i], y = state.y[i];
        double density = 1, sum_x = 0, sum_y = 0, squared = 0;
        const int offset = i * NEIGHBORS, end = offset + state.nearby_count[i];
        for (int k = offset; k < end; k++) {
            const int j = state.nearby[k];
            const double dx = x - state.x[j], dy = y - state.y[j];
            const double kernel = 1 - (dx * dx + dy * dy) / radius_squared;
            if (kernel <= 0) continue;
            density += kernel * kernel;
            const double gradient = kernel * kernel_slope / rest_density;
            const double gx = dx * gradient, gy = dy * gradient;
            sum_x += gx;
            sum_y += gy;
            squared += gx * gx + gy * gy;
        }
        state.lambda[i] = positive(density / rest_density - 1) /
            (squared + sum_x * sum_x + sum_y * sum_y + .035);
    }
}

static void project(int keep_shape) {
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        const double x = state.x[i], y = state.y[i], lambda = state.lambda[i];
        const uint32_t color = state.colors[i];
        double px = 0, py = 0;
        const int offset = i * NEIGHBORS, end = offset + state.nearby_count[i];
        for (int k = offset; k < end; k++) {
            const int j = state.nearby[k];
            const double dx = x - state.x[j], dy = y - state.y[j];
            const double distance_squared = dx * dx + dy * dy;
            const double kernel = 1 - distance_squared / radius_squared;
            if (kernel <= 0) continue;
            const double pressure = (lambda + state.lambda[j]) * kernel * kernel_slope / rest_density;
            const double cohesion = distance_squared > .96 ?
                (color == state.colors[j] ? .095 : .038) * kernel * (distance_squared - .96) : 0;
            const double separation = positive(.56 - distance_squared) * .27;
            const double weight = pressure + separation - cohesion;
            px += dx * weight;
            py += dy * weight;
        }
        // Fit a local rotation to the surviving shape bonds. Near the heated
        // outlet, the same neighborhoods gradually lose stiffness.
        const double heat = state.heat[i];
        if (keep_shape && heat < .97) {
            int count = 1;
            double center_x = 0, center_y = 0, rest_x = 0, rest_y = 0, dot = 0, cross = 0;
            for (int k = 0; k < BONDS; k++) {
                const int j = state.bonds[i * BONDS + k];
                if (j < 0 || !state.alive[j]) continue;
                const double dx = state.x[j] - x, dy = state.y[j] - y;
                if (dx * dx + dy * dy > 6.25) continue;
                const double rx = shape_x[k], ry = shape_y[k];
                count++;
                center_x += dx;
                center_y += dy;
                rest_x += rx;
                rest_y += ry;
                dot += dx * rx + dy * ry;
                cross += dy * rx - dx * ry;
            }
            dot -= (center_x * rest_x + center_y * rest_y) / count;
            cross -= (center_y * rest_x - center_x * rest_y) / count;
            const double norm = __builtin_sqrt(dot * dot + cross * cross);
            if (norm > .01) {
                const double stiffness = .64 * (1 - heat) / count;
                px += stiffness * (center_x - (dot * rest_x - cross * rest_y) / norm);
                py += stiffness * (center_y - (cross * rest_x + dot * rest_y) / norm);
            }
        }
        state.shift_x[i] = clamp(px, -.38, .38);
        state.shift_y[i] = clamp(py, -.38, .38);
    }
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        const double dx = state.shift_x[i], dy = state.shift_y[i];
        state.x[i] += dx;
        state.y[i] += dy;
        state.correction_x[i] += dx;
        state.correction_y[i] += dy;
    }
}

static void substep(void) {
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        state.x[i] += clamp(state.velocity_x[i], -.64, .64);
        state.y[i] += clamp(state.velocity_y[i] - .015, -.78, .64);
        state.correction_x[i] = 0;
        state.correction_y[i] = 0;
        const double y = state.y[i], heat = state.heat[i];
        if (y < 12) state.heat[i] += (clamp((12 - y) / 9, 0, 1) - heat) * .085;
    }
    contain(1);
    find_neighbors();
    for (int iteration = 0; iteration < 2; iteration++) {
        compute_density();
        project(iteration == 0);
        contain(0);
    }
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        const double old_x = clamp(state.velocity_x[i], -.64, .64);
        const double old_y = clamp(state.velocity_y[i] - .015, -.78, .64);
        state.velocity_x[i] = (old_x + state.correction_x[i]) * .84;
        state.velocity_y[i] = (old_y + state.correction_y[i]) * .84;
    }
    for (int i = 0; i < state.size; i++) {
        if (!state.alive[i]) continue;
        const double x = state.x[i], y = state.y[i];
        const double vx = state.velocity_x[i], vy = state.velocity_y[i];
        const uint32_t color = state.colors[i];
        double dx = 0, dy = 0;
        const int offset = i * NEIGHBORS, end = offset + state.nearby_count[i];
        for (int k = offset; k < end; k++) {
            const int j = state.nearby[k];
            const double rx = x - state.x[j], ry = y - state.y[j];
            const double kernel = positive(1 - (rx * rx + ry * ry) / radius_squared);
            const double weight = (kernel * kernel) * (color == state.colors[j] ? .11 : .055);
            dx += (state.velocity_x[j] - vx) * weight;
            dy += (state.velocity_y[j] - vy) * weight;
        }
        state.correction_x[i] = dx;
        state.correction_y[i] = dy;
    }
    for (int i = 0; i < state.size; i++) {
        // Promote additions too, to mirror JS before the Float32 store.
        state.velocity_x[i] += (double)state.correction_x[i];
        state.velocity_y[i] += (double)state.correction_y[i];
    }
}

EXPORT(advance)
void advance(void) {
    substep();
    substep();
}
