{
  "targets": [
    {
      "target_name": "chain_hook",
      "sources": ["src/chain_hook.cc"],
      "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "NOMINMAX", "WIN32_LEAN_AND_MEAN"],
      "libraries": ["user32.lib", "version.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}
