-- migrate:up

-- Sub-millisecond ordering for `flightrules_uuid_v7`.
--
-- The Phase 01 implementation encoded 48-bit Unix milliseconds followed by 74 random bits, so two
-- identifiers generated inside the same millisecond ordered randomly. The integration test that
-- asserts sortability failed roughly one run in five, which is a defect in the generator rather
-- than in the test: PRD section 14 requires a sortable format, and an identifier that only sorts
-- across millisecond boundaries is not one. Anything that paginates by id would silently return
-- rows out of order, and the failure would be intermittent and very hard to attribute.
--
-- This is RFC 9562 Method 3, "Replace Leftmost Random Bits with Increased Clock Precision": the
-- 12 bits of `rand_a` carry the sub-millisecond remainder. `clock_timestamp()` is microsecond
-- resolution, so the remainder is 0..999 and fits with room to spare, giving monotonic ordering
-- down to one microsecond. The remaining 62 bits stay random, so the identifier is still
-- unguessable.
create or replace function flightrules_uuid_v7() returns uuid
language plpgsql
volatile
as $$
declare
  unix_us bigint := (extract(epoch from clock_timestamp()) * 1000000)::bigint;
  unix_ms bigint := unix_us / 1000;
  sub_ms int := (unix_us % 1000)::int;
  bytes bytea := gen_random_bytes(16);
begin
  bytes := set_byte(bytes, 0, ((unix_ms >> 40) & 255)::int);
  bytes := set_byte(bytes, 1, ((unix_ms >> 32) & 255)::int);
  bytes := set_byte(bytes, 2, ((unix_ms >> 24) & 255)::int);
  bytes := set_byte(bytes, 3, ((unix_ms >> 16) & 255)::int);
  bytes := set_byte(bytes, 4, ((unix_ms >> 8) & 255)::int);
  bytes := set_byte(bytes, 5, (unix_ms & 255)::int);
  -- Version 7 nibble, then the high 4 bits of the sub-millisecond remainder.
  bytes := set_byte(bytes, 6, (112 | ((sub_ms >> 8) & 15)));
  bytes := set_byte(bytes, 7, (sub_ms & 255));
  -- Variant bits; the remaining 62 bits of byte 8 onwards stay random.
  bytes := set_byte(bytes, 8, ((get_byte(bytes, 8) & 63) | 128));
  return encode(bytes, 'hex')::uuid;
end;
$$;

-- migrate:down

create or replace function flightrules_uuid_v7() returns uuid
language plpgsql
volatile
as $$
declare
  unix_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  bytes bytea := gen_random_bytes(16);
begin
  bytes := set_byte(bytes, 0, ((unix_ms >> 40) & 255)::int);
  bytes := set_byte(bytes, 1, ((unix_ms >> 32) & 255)::int);
  bytes := set_byte(bytes, 2, ((unix_ms >> 24) & 255)::int);
  bytes := set_byte(bytes, 3, ((unix_ms >> 16) & 255)::int);
  bytes := set_byte(bytes, 4, ((unix_ms >> 8) & 255)::int);
  bytes := set_byte(bytes, 5, (unix_ms & 255)::int);
  bytes := set_byte(bytes, 6, ((get_byte(bytes, 6) & 15) | 112));
  bytes := set_byte(bytes, 8, ((get_byte(bytes, 8) & 63) | 128));
  return encode(bytes, 'hex')::uuid;
end;
$$;
