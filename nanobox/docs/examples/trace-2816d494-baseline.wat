  (func (;64;) (export "f18") (type 0) (param i32)
    (local i64 i64 i32 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i64 i32 i32 i32 i32 i32 i32 i64 i32 i32 i64 i32 i32 i32)
    i64.const -1
    local.set 42
    i32.const 0
    i64.load offset=368504
    i64.const 3
    i64.sub
    local.set 1
    i32.const 0
    i64.load offset=368584
    local.set 2
    i32.const 0
    i32.load8_u offset=386788
    local.set 3
    block  ;; label = @1
      i32.const 0
      i32.load offset=386776
      if  ;; label = @2
        i32.const 0
        local.get 1
        i64.const 3
        i64.add
        i64.store offset=368504
        i32.const 0
        local.get 1
        i64.store offset=368560
        i32.const 0
        local.get 2
        i64.store offset=368584
        i64.const -1
        local.set 42
        i32.const 0
        i32.const 0
        i32.store8 offset=21457597
        local.get 0
        call 37
        i32.const 0
        i32.load8_u offset=21457597
        i32.const 0
        i32.load offset=386776
        i32.or
        if  ;; label = @3
          return
        end
        i32.const 0
        i64.load offset=368584
        i64.const 1
        i64.sub
        local.set 2
        return
      end
      block  ;; label = @2
        i32.const 0
        i64.load offset=368400
        local.set 8
        local.get 8
        local.set 24
        i32.const 0
        i64.load offset=368376
        local.set 5
        local.get 5
        local.set 26
        local.get 26
        local.set 28
        block (result i64)  ;; label = @3
          block  ;; label = @4
            block  ;; label = @5
              block  ;; label = @6
                local.get 28
                i64.const -4096
                i64.and
                local.get 42
                i64.ne
                br_if 0 (;@6;)
                local.get 28
                i32.wrap_i64
                i32.const 4095
                i32.and
                i32.const 4088
                i32.gt_u
                br_if 0 (;@6;)
                i32.const 0
                i64.load32_u offset=386860
                local.set 4
                local.get 4
                i64.const 7
                i64.and
                i64.const 0
                i64.ne
                br_if 0 (;@6;)
                local.get 44
                i32.const 4
                local.get 3
                i32.shl
                i32.and
                i32.eqz
                br_if 0 (;@6;)
                br 1 (;@5;)
              end
              local.get 28
              i32.wrap_i64
              i32.const 7
              i32.add
              i32.const 8384512
              i32.and
              i32.const 7
              i32.shr_u
              i32.const 386880
              i32.add
              local.set 36
              local.get 36
              i64.load
              local.get 28
              local.get 4
              i64.const 7
              i64.and
              i64.const -4096
              i64.or
              i64.and
              i64.ne
              br_if 1 (;@4;)
              local.get 36
              i32.load offset=20
              i32.const 4
              local.get 3
              i32.shl
              i32.and
              i32.eqz
              br_if 1 (;@4;)
              local.get 28
              i64.const -4096
              i64.and
              local.set 42
              local.get 36
              i32.load offset=16
              local.set 43
              local.get 36
              i32.load offset=20
              local.set 44
              local.get 36
              i64.load offset=8
              local.set 45
              local.get 45
              i32.wrap_i64
              i32.const -4096
              i32.and
              i32.const 10
              i32.shr_u
              i32.const 27868576
              i32.add
              i32.load
              i32.eqz
              local.set 46
            end
            local.get 46
            i32.eqz
            if  ;; label = @5
              local.get 45
              local.get 28
              i64.const 4095
              i64.and
              i64.or
              local.set 35
              local.get 35
              i32.wrap_i64
              i32.const -4096
              i32.and
              i32.const 10
              i32.shr_u
              i32.const 27868576
              i32.add
              i32.load
              if  ;; label = @6
                local.get 35
                i32.const 8
                call 5
              end
            end
            local.get 43
            local.get 28
            i32.wrap_i64
            i32.const 4095
            i32.and
            i32.add
            local.tee 37
            i64.load align=1
            br 1 (;@3;)
          end
          i32.const 0
          local.get 1
          i64.const 3
          i64.add
          i64.store offset=368504
          i32.const 0
          local.get 1
          i64.store offset=368560
          i32.const 0
          local.get 2
          i64.store offset=368584
          i32.const 0
          local.set 37
          i32.const 3
          local.get 28
          call 35
        end
        local.set 23
        local.get 23
        local.get 24
        i64.add
        local.set 25
        local.get 37
        if  ;; label = @3
          local.get 37
          local.get 25
          i64.store align=1
        else
          local.get 25
          call 36
        end
        local.get 23
        local.get 24
        i64.and
        local.get 23
        local.get 24
        i64.or
        local.get 25
        i64.const -1
        i64.xor
        i64.and
        i64.or
        local.set 31
        local.get 25
        local.set 21
        local.get 31
        i64.const 8
        i64.and
        local.get 31
        i64.const 62
        i64.shr_u
        i64.const 30
        i64.shl
        i64.or
        i64.const 4294967295
        i64.and
        local.set 22
      end
      i32.const 0
      i32.load offset=386776
      if  ;; label = @2
        local.get 1
        i64.const 3
        i64.add
        local.set 30
        i32.const 0
        local.get 21
        i64.store offset=368544
        i32.const 0
        local.get 22
        i64.store offset=368552
        i32.const 0
        local.get 30
        i64.store offset=368504
        i32.const 0
        local.get 30
        i64.store offset=368560
        i32.const 0
        local.get 2
        i64.const 1
        i64.add
        i64.store offset=368584
        br 1 (;@1;)
      end
      block  ;; label = @2
        i32.const 0
        i64.load offset=368408
        local.set 9
        local.get 9
        local.set 23
        local.get 23
        local.set 28
        block (result i64)  ;; label = @3
          block  ;; label = @4
            block  ;; label = @5
              block  ;; label = @6
                local.get 28
                i64.const -4096
                i64.and
                local.get 42
                i64.ne
                br_if 0 (;@6;)
                local.get 28
                i32.wrap_i64
                i32.const 4095
                i32.and
                i32.const 4088
                i32.gt_u
                br_if 0 (;@6;)
                local.get 4
                i64.const 7
                i64.and
                i64.const 0
                i64.ne
                br_if 0 (;@6;)
                local.get 44
                i32.const 1
                local.get 3
                i32.shl
                i32.and
                i32.eqz
                br_if 0 (;@6;)
                br 1 (;@5;)
              end
              local.get 28
              i32.wrap_i64
              i32.const 7
              i32.add
              i32.const 8384512
              i32.and
              i32.const 7
              i32.shr_u
              i32.const 386880
              i32.add
              local.set 36
              local.get 36
              i64.load
              local.get 28
              local.get 4
              i64.const 7
              i64.and
              i64.const -4096
              i64.or
              i64.and
              i64.ne
              br_if 1 (;@4;)
              local.get 36
              i32.load offset=20
              i32.const 1
              local.get 3
              i32.shl
              i32.and
              i32.eqz
              br_if 1 (;@4;)
              local.get 28
              i64.const -4096
              i64.and
              local.set 42
              local.get 36
              i32.load offset=16
              local.set 43
              local.get 36
              i32.load offset=20
              local.set 44
              local.get 36
              i64.load offset=8
              local.set 45
              local.get 45
              i32.wrap_i64
              i32.const -4096
              i32.and
              i32.const 10
              i32.shr_u
              i32.const 27868576
              i32.add
              i32.load
              i32.eqz
              local.set 46
            end
            local.get 43
            local.get 28
            i32.wrap_i64
            i32.const 4095
            i32.and
            i32.add
            i64.load align=1
            br 1 (;@3;)
          end
          i32.const 0
          local.get 21
          i64.store offset=368544
          i32.const 0
          local.get 22
          i64.store offset=368552
          i32.const 0
          local.get 1
          i64.const 4
          i64.add
          i64.store offset=368504
          i32.const 0
          local.get 1
          i64.const 3
          i64.add
          i64.store offset=368560
          i32.const 0
          local.get 2
          i64.const 1
          i64.add
          i64.store offset=368584
          local.get 23
          call 1
        end
        local.set 24
        local.get 23
        i64.const 8
        i64.add
        local.set 9
        local.get 24
        local.set 8
      end
      i32.const 0
      i32.load offset=386776
      if  ;; label = @2
        local.get 1
        i64.const 4
        i64.add
        local.set 30
        i32.const 0
        local.get 8
        i64.store offset=368400
        i32.const 0
        local.get 9
        i64.store offset=368408
        i32.const 0
        local.get 21
        i64.store offset=368544
        i32.const 0
        local.get 22
        i64.store offset=368552
        i32.const 0
        local.get 30
        i64.store offset=368504
        i32.const 0
        local.get 30
        i64.store offset=368560
        i32.const 0
        local.get 2
        i64.const 2
        i64.add
        i64.store offset=368584
        br 1 (;@1;)
      end
      block  ;; label = @2
        local.get 9
        local.set 23
        local.get 23
        local.set 28
        block (result i64)  ;; label = @3
          block  ;; label = @4
            block  ;; label = @5
              block  ;; label = @6
                local.get 28
                i64.const -4096
                i64.and
                local.get 42
                i64.ne
                br_if 0 (;@6;)
                local.get 28
                i32.wrap_i64
                i32.const 4095
                i32.and
                i32.const 4088
                i32.gt_u
                br_if 0 (;@6;)
                local.get 4
                i64.const 7
                i64.and
                i64.const 0
                i64.ne
                br_if 0 (;@6;)
                local.get 44
                i32.const 1
                local.get 3
                i32.shl
                i32.and
                i32.eqz
                br_if 0 (;@6;)
                br 1 (;@5;)
              end
              local.get 28
              i32.wrap_i64
              i32.const 7
              i32.add
              i32.const 8384512
              i32.and
              i32.const 7
              i32.shr_u
              i32.const 386880
              i32.add
              local.set 36
              local.get 36
              i64.load
              local.get 28
              local.get 4
              i64.const 7
              i64.and
              i64.const -4096
              i64.or
              i64.and
              i64.ne
              br_if 1 (;@4;)
              local.get 36
              i32.load offset=20
              i32.const 1
              local.get 3
              i32.shl
              i32.and
              i32.eqz
              br_if 1 (;@4;)
              local.get 28
              i64.const -4096
              i64.and
              local.set 42
              local.get 36
              i32.load offset=16
              local.set 43
              local.get 36
              i32.load offset=20
              local.set 44
              local.get 36
              i64.load offset=8
              local.set 45
              local.get 45
              i32.wrap_i64
              i32.const -4096
              i32.and
              i32.const 10
              i32.shr_u
              i32.const 27868576
              i32.add
              i32.load
              i32.eqz
              local.set 46
            end
            local.get 43
            local.get 28
            i32.wrap_i64
            i32.const 4095
            i32.and
            i32.add
            i64.load align=1
            br 1 (;@3;)
          end
          i32.const 0
          local.get 8
          i64.store offset=368400
          i32.const 0
          local.get 9
          i64.store offset=368408
          i32.const 0
          local.get 21
          i64.store offset=368544
          i32.const 0
          local.get 22
          i64.store offset=368552
          i32.const 0
          local.get 1
          i64.const 5
          i64.add
          i64.store offset=368504
          i32.const 0
          local.get 1
          i64.const 4
          i64.add
          i64.store offset=368560
          i32.const 0
          local.get 2
          i64.const 2
          i64.add
          i64.store offset=368584
          local.get 23
          call 1
        end
        local.set 24
        local.get 23
        i64.const 8
        i64.add
        local.set 9
        local.get 24
        local.set 10
      end
      i32.const 0
      i32.load offset=386776
      if  ;; label = @2
        local.get 1
        i64.const 5
        i64.add
        local.set 30
        i32.const 0
        local.get 8
        i64.store offset=368400
        i32.const 0
        local.get 9
        i64.store offset=368408
        i32.const 0
        local.get 10
        i64.store offset=368416
        i32.const 0
        local.get 21
        i64.store offset=368544
        i32.const 0
        local.get 22
        i64.store offset=368552
        i32.const 0
        local.get 30
        i64.store offset=368504
        i32.const 0
        local.get 30
        i64.store offset=368560
        i32.const 0
        local.get 2
        i64.const 3
        i64.add
        i64.store offset=368584
        br 1 (;@1;)
      end
      block  ;; label = @2
        local.get 1
        i64.const 10
        i64.add
        i64.const -717242
        i64.add
        local.set 23
        local.get 23
        i64.const 47
        i64.shr_s
        i64.const 1
        i64.add
        i64.const 2
        i64.lt_u
        i32.eqz
        if  ;; label = @3
          i32.const 0
          local.get 8
          i64.store offset=368400
          i32.const 0
          local.get 9
          i64.store offset=368408
          i32.const 0
          local.get 10
          i64.store offset=368416
          i32.const 0
          local.get 21
          i64.store offset=368544
          i32.const 0
          local.get 22
          i64.store offset=368552
          i32.const 0
          local.get 1
          i64.const 10
          i64.add
          i64.store offset=368504
          i32.const 0
          local.get 1
          i64.const 5
          i64.add
          i64.store offset=368560
          i32.const 0
          local.get 2
          i64.const 3
          i64.add
          i64.store offset=368584
          i64.const -1
          local.set 42
          i32.const 0
          i32.const 0
          i32.store8 offset=21457597
          local.get 0
          i32.const 96
          i32.add
          call 24
          i32.const 0
          i32.load8_u offset=21457597
          i32.const 0
          i32.load offset=386776
          i32.or
          drop
          return
        end
        local.get 23
        local.set 30
        i32.const 0
        local.get 8
        i64.store offset=368400
        i32.const 0
        local.get 9
        i64.store offset=368408
        i32.const 0
        local.get 10
        i64.store offset=368416
        i32.const 0
        local.get 21
        i64.store offset=368544
        i32.const 0
        local.get 22
        i64.store offset=368552
        i32.const 0
        local.get 30
        i64.store offset=368504
        i32.const 0
        local.get 30
        i64.store offset=368560
        i32.const 0
        local.get 2
        i64.const 4
        i64.add
        i64.store offset=368584
        br 1 (;@1;)
      end
      local.get 1
      i64.const 10
      i64.add
      local.set 30
      i32.const 0
      local.get 8
      i64.store offset=368400
      i32.const 0
      local.get 9
      i64.store offset=368408
      i32.const 0
      local.get 10
      i64.store offset=368416
      i32.const 0
      local.get 21
      i64.store offset=368544
      i32.const 0
      local.get 22
      i64.store offset=368552
      i32.const 0
      local.get 30
      i64.store offset=368504
      i32.const 0
      local.get 30
      i64.store offset=368560
      i32.const 0
      local.get 2
      i64.const 4
      i64.add
      i64.store offset=368584
      br 0 (;@1;)
      return
    end
    i32.const 0
    i32.const 3282
    return_call_indirect (type 0))