; MedTutor NSIS 自定义安装与“零残留”卸载脚本
; 编码要求: UTF-8 with BOM (配合 electron-builder Unicode true 使用)

!macro customInstall
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    !ifdef MENU_FILENAME
      CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
      StrCpy $0 "$SMPROGRAMS\${MENU_FILENAME}\Uninstall ${SHORTCUT_NAME}.lnk"
    !else
      StrCpy $0 "$SMPROGRAMS\Uninstall ${SHORTCUT_NAME}.lnk"
    !endif
    ${If} $installMode == "all"
      StrCpy $1 "/allusers"
    ${Else}
      StrCpy $1 "/currentuser"
    ${EndIf}
    ClearErrors
    CreateShortCut "$0" "$INSTDIR\${UNINSTALL_FILENAME}" "$1" "$INSTDIR\${UNINSTALL_FILENAME}" 0 "" "" "卸载 ${PRODUCT_NAME}"
    ClearErrors
  !endif
!macroend

!macro customUnInstall
  !define MEDTUTOR_UNINSTALL_UID ${__LINE__}

  ; 切换工作目录离开安装目录，防止 $INSTDIR 被当前工作目录占用导致无法删除
  SetOutPath $TEMP

  Var /GLOBAL medTutorPurgeUserData
  Var /GLOBAL medTutorHasKeepAppData
  Var /GLOBAL medTutorCleanInstDir
  StrCpy $medTutorPurgeUserData "0"
  StrCpy $medTutorHasKeepAppData "0"

  ; 规范化 $INSTDIR，去掉可能存在的末尾反斜杠
  StrCpy $medTutorCleanInstDir "$INSTDIR"
  StrCpy $0 $medTutorCleanInstDir 1 -1
  ${If} $0 == "\"
    StrCpy $medTutorCleanInstDir $medTutorCleanInstDir -1
  ${EndIf}

  ClearErrors
  ${GetParameters} $R0
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    StrCpy $medTutorHasKeepAppData "1"
  ${EndIf}

  ; 仅在非升级且未传入 /KEEP_APP_DATA 时，判断是否清理个人学习数据
  ${IfNot} ${isUpdated}
  ${AndIf} $medTutorHasKeepAppData != "1"
    ${If} ${Silent}
      ClearErrors
      ${GetParameters} $R0
      ${GetOptions} $R0 "/PURGE" $R1
      ${IfNot} ${Errors}
        StrCpy $medTutorPurgeUserData "1"
      ${EndIf}
    ${Else}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "是否同时彻底删除 MedTutor 的个人学习数据、配置和本地缓存（包含 %APPDATA%\MedTutor）？$\r$\n$\r$\n选择“是”将永久删除个人学习数据且无法恢复；$\r$\n选择“否”仅卸载程序并保留您的学习数据（推荐）。" \
        IDYES medtutor_purge_yes_${MEDTUTOR_UNINSTALL_UID} IDNO medtutor_purge_no_${MEDTUTOR_UNINSTALL_UID}
      medtutor_purge_yes_${MEDTUTOR_UNINSTALL_UID}:
        StrCpy $medTutorPurgeUserData "1"
      medtutor_purge_no_${MEDTUTOR_UNINSTALL_UID}:
    ${EndIf}
  ${EndIf}

  ; 短暂等待进程句柄彻底释放，减少程序目录文件锁残留概率
  Sleep 150

  ; 清理开始菜单快捷方式（含主快捷方式、卸载快捷方式与整个分类文件夹）及桌面快捷方式
  ${IfNot} ${isKeepShortcuts}
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      !ifdef MENU_FILENAME
        WinShell::UninstShortcut "$SMPROGRAMS\${MENU_FILENAME}\Uninstall ${SHORTCUT_NAME}.lnk"
        Delete "$SMPROGRAMS\${MENU_FILENAME}\Uninstall ${SHORTCUT_NAME}.lnk"
        WinShell::UninstShortcut "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
        Delete "$SMPROGRAMS\${MENU_FILENAME}\${SHORTCUT_NAME}.lnk"
        WinShell::UninstShortcut "$oldStartMenuLink"
        Delete "$oldStartMenuLink"
        RMDir /r "$SMPROGRAMS\${MENU_FILENAME}"
      !else
        WinShell::UninstShortcut "$SMPROGRAMS\Uninstall ${SHORTCUT_NAME}.lnk"
        Delete "$SMPROGRAMS\Uninstall ${SHORTCUT_NAME}.lnk"
        WinShell::UninstShortcut "$oldStartMenuLink"
        Delete "$oldStartMenuLink"
      !endif
    !endif

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
      WinShell::UninstShortcut "$DESKTOP\${SHORTCUT_NAME}.lnk"
      Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    !endif
  ${EndIf}

  ${If} ${isUpdated}
    ; 覆盖升级时先用 \\?\ 长路径清理旧版 node_modules，防止 un.atomicRMDir 在 >260 字符路径下 Rename 失败导致升级中止
    ${If} ${FileExists} "$medTutorCleanInstDir\resources\app\node_modules\*.*"
      nsExec::Exec '"$SYSDIR\cmd.exe" /D /C rd /s /q "\\?\$medTutorCleanInstDir\resources\app\node_modules"'
      Pop $0
    ${EndIf}
  ${Else}
    ; 真正卸载时使用 \\?\ 长路径清理 $INSTDIR\resources，规避 NSIS RMDir 在 >260 字符路径下的跳过残留问题
    ${If} ${FileExists} "$medTutorCleanInstDir\resources\*.*"
      nsExec::Exec '"$SYSDIR\cmd.exe" /D /C rd /s /q "\\?\$medTutorCleanInstDir\resources"'
      Pop $0
    ${EndIf}

    ${If} $installMode == "all"
      SetShellVarContext current
    ${EndIf}

    ; 即使保留个人学习数据，也安全清理纯临时/更新器缓存目录
    RMDir /r "$LOCALAPPDATA\medtutor-updater"
    RMDir /r "$LOCALAPPDATA\@pi-guidesktop-updater"

    ${If} $medTutorPurgeUserData == "1"
    ${AndIf} $medTutorHasKeepAppData != "1"
      RMDir /r "$APPDATA\MedTutor"
      ${If} ${FileExists} "$APPDATA\MedTutor\*.*"
        nsExec::Exec '"$SYSDIR\cmd.exe" /D /C rd /s /q "\\?\$APPDATA\MedTutor"'
        Pop $0
      ${EndIf}
      RMDir /r "$APPDATA\@pi-guidesktop"
      RMDir "$APPDATA\@pi-gui"

      RMDir /r "$LOCALAPPDATA\MedTutor"
      ${If} ${FileExists} "$LOCALAPPDATA\MedTutor\*.*"
        nsExec::Exec '"$SYSDIR\cmd.exe" /D /C rd /s /q "\\?\$LOCALAPPDATA\MedTutor"'
        Pop $0
      ${EndIf}
      RMDir /r "$LOCALAPPDATA\@pi-guidesktop"
      RMDir "$LOCALAPPDATA\@pi-gui"
      RMDir "$LOCALAPPDATA\Programs\MedTutor"
    ${EndIf}

    ${If} $installMode == "all"
      SetShellVarContext all
    ${EndIf}

    ; 清理应用自身及 Windows AppUserModelId 注册表残留键
    DeleteRegKey HKCU "Software\MedTutor"
    DeleteRegKey HKCU "Software\com.medtutor.desktop"
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.medtutor.desktop"
    DeleteRegKey /ifempty HKCU "Software\Classes\AppUserModelId"
    DeleteRegKey HKCU "Software\${APP_PACKAGE_NAME}"
    DeleteRegKey HKCU "Software\@pi-guidesktop"
    DeleteRegKey /ifempty HKCU "Software\@pi-gui"

    ${If} $installMode == "all"
      DeleteRegKey HKLM "Software\MedTutor"
      DeleteRegKey HKLM "Software\com.medtutor.desktop"
      DeleteRegKey HKLM "Software\Classes\AppUserModelId\com.medtutor.desktop"
      DeleteRegKey /ifempty HKLM "Software\Classes\AppUserModelId"
      DeleteRegKey HKLM "Software\${APP_PACKAGE_NAME}"
      DeleteRegKey HKLM "Software\@pi-guidesktop"
      DeleteRegKey /ifempty HKLM "Software\@pi-gui"
    ${EndIf}
  ${EndIf}

  !undef MEDTUTOR_UNINSTALL_UID
!macroend